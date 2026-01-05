#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod db;
mod git;
mod checkpoints;
mod attachments;
mod path_utils;
mod paths;
mod repos;
mod settings;
mod sessions;
mod sidecar;
mod spotlight;
mod workspace;
mod workspace_content;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(unix)]
use std::time::Duration;
use tauri::{Emitter, Manager};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(unix)]
use libc;

use crate::db::{Database, DbError};
use crate::attachments::AttachmentRecord;
use crate::checkpoints::{
  create_checkpoint,
  delete_checkpoint,
  restore_checkpoint,
  CheckpointOutcome,
};
use crate::spotlight::SpotlightManager;
use crate::workspace_content::{read_notes, read_todos, write_notes, write_todos, ManualTodoItem};
use crate::git::{
  branch_exists, clone_repo, create_worktree, diff as git_diff, inspect_repo, is_git_repo,
  list_branches, list_status, read_supertree_config, remove_worktree, repo_name_from_url,
  set_sparse_checkout, GitStatusEntry,
};
use crate::paths::{ensure_dirs, resolve_paths, AppPaths};
use crate::repos::{NewRepo, RepoRecord};
use crate::settings::SettingEntry;
use crate::sidecar::SidecarManager;
use crate::sessions::{SessionMessageRecord, SessionRecord};

#[tauri::command]
fn hello(name: String) -> String {
  format!("Hello, {}!", name)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
  version: String,
  paths: AppPaths,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FilePreview {
  path: String,
  content: String,
  truncated: bool,
  binary: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceDiffResponse {
  diff: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GithubAuthStatus {
  available: bool,
  authenticated: bool,
  message: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PullRequestInfo {
  number: i64,
  url: String,
  base_branch: String,
  head_branch: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PullRequestCheck {
  name: String,
  status: Option<String>,
  conclusion: Option<String>,
  details_url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PullRequestCheckSummary {
  total: usize,
  failed: usize,
  pending: usize,
  success: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PullRequestStatus {
  number: i64,
  url: String,
  base_branch: String,
  head_branch: String,
  review_decision: Option<String>,
  mergeable: Option<String>,
  state: Option<String>,
  checks: PullRequestCheckSummary,
  failing_checks: Vec<PullRequestCheck>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PullRequestCommentsResult {
  content: String,
  new_comments: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RunOutputEvent {
  workspace_id: String,
  stream: String,
  line: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RunExitEvent {
  workspace_id: String,
  code: Option<i32>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TerminalOutputEvent {
  terminal_id: String,
  data: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TerminalExitEvent {
  terminal_id: String,
}

#[derive(Default, Clone)]
struct RunManager {
  processes: Arc<Mutex<HashMap<String, RunProcess>>>,
}

struct RunProcess {
  pid: u32,
  repo_id: String,
}

#[derive(Default, Clone)]
struct TerminalManager {
  sessions: Arc<Mutex<HashMap<String, TerminalSession>>>,
}

struct TerminalSession {
  master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
  writer: Arc<Mutex<Box<dyn Write + Send>>>,
  child: Arc<Mutex<Box<dyn portable_pty::Child + Send>>>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum AddRepoRequest {
  Local { path: String },
  Clone { url: String, destination: Option<String> },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum CreateWorkspaceRequest {
  Default { repo_id: String },
  Branch { repo_id: String, branch: String },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceDiffRequest {
  workspace_id: String,
  path: Option<String>,
  stat: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum OpenTarget {
  System,
  Vscode,
  Cursor,
  Zed,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateSessionRequest {
  workspace_id: String,
  agent_type: String,
  model: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendSessionMessageRequest {
  session_id: String,
  prompt: String,
  permission_mode: Option<String>,
  attachment_ids: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResetSessionToTurnRequest {
  session_id: String,
  turn_id: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateAttachmentRequest {
  session_id: String,
  file_name: String,
  mime_type: Option<String>,
  source_path: Option<String>,
  bytes: Option<Vec<u8>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveAskUserQuestionRequest {
  request_id: String,
  answers: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveExitPlanModeRequest {
  request_id: String,
  approved: bool,
  turn_id: Option<i64>,
}

#[allow(non_snake_case)]
#[tauri::command]
fn getAppInfo(app: tauri::AppHandle, paths: tauri::State<'_, AppPaths>) -> AppInfo {
  AppInfo {
    version: app.package_info().version.to_string(),
    paths: paths.inner().clone(),
  }
}

#[allow(non_snake_case)]
#[tauri::command]
async fn listSettings(db: tauri::State<'_, Database>) -> Result<Vec<SettingEntry>, String> {
  settings::list_settings(db.pool())
    .await
    .map_err(|err| err.to_string())
}

#[allow(non_snake_case)]
#[tauri::command]
async fn setSetting(
  db: tauri::State<'_, Database>,
  key: String,
  value: String,
) -> Result<(), String> {
  settings::set_setting(db.pool(), &key, &value)
    .await
    .map_err(|err| err.to_string())
}

#[allow(non_snake_case)]
#[tauri::command]
async fn getEnvVars(db: tauri::State<'_, Database>) -> Result<String, String> {
  settings::get_env_vars(db.pool())
    .await
    .map_err(|err| err.to_string())
}

#[allow(non_snake_case)]
#[tauri::command]
async fn setEnvVars(db: tauri::State<'_, Database>, value: String) -> Result<(), String> {
  settings::set_env_vars(db.pool(), &value)
    .await
    .map_err(|err| err.to_string())
}

#[allow(non_snake_case)]
#[tauri::command]
async fn listRepos(db: tauri::State<'_, Database>) -> Result<Vec<RepoRecord>, String> {
  repos::list_repos(db.pool())
    .await
    .map_err(|err| err.to_string())
}

#[allow(non_snake_case)]
#[tauri::command]
async fn addRepo(
  db: tauri::State<'_, Database>,
  paths: tauri::State<'_, AppPaths>,
  payload: AddRepoRequest,
) -> Result<RepoRecord, String> {
  let repo_path = match payload {
    AddRepoRequest::Local { path } => {
      let candidate = PathBuf::from(path.trim());
      if !candidate.exists() {
        return Err(format!("Path does not exist: {}", candidate.display()));
      }
      if !candidate.is_dir() {
        return Err(format!("Path is not a directory: {}", candidate.display()));
      }
      let is_repo = is_git_repo(&candidate).map_err(|err| err.to_string())?;
      if !is_repo {
        return Err("Selected path is not a git repository".to_string());
      }
      candidate
    }
    AddRepoRequest::Clone { url, destination } => {
      let target_dir = match destination {
        Some(value) if !value.trim().is_empty() => PathBuf::from(value.trim()),
        _ => paths.workspaces_dir.join(repo_name_from_url(&url)),
      };
      if target_dir.exists() {
        return Err(format!(
          "Clone destination already exists: {}",
          target_dir.display()
        ));
      }
      if let Some(parent) = target_dir.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
      }
      clone_repo(&url, &target_dir).map_err(|err| err.to_string())?;
      target_dir
    }
  };

  let identity = inspect_repo(&repo_path).map_err(|err| err.to_string())?;
  let scripts = read_supertree_config(&identity.root_path)
    .map_err(|err| err.to_string())?
    .unwrap_or_default();

  let new_repo = NewRepo {
    name: identity.name,
    root_path: identity.root_path.to_string_lossy().to_string(),
    remote_url: identity.remote_url,
    default_branch: identity.default_branch,
    scripts_setup: scripts.setup,
    scripts_run: scripts.run,
    scripts_archive: scripts.archive,
    run_script_mode: scripts.run_script_mode,
  };

  repos::insert_repo(db.pool(), new_repo)
    .await
    .map_err(|err| err.to_string())
}

#[allow(non_snake_case)]
#[tauri::command]
async fn removeRepo(
  db: tauri::State<'_, Database>,
  paths: tauri::State<'_, AppPaths>,
  repo_id: String,
) -> Result<(), String> {
  let workspace_root = paths
    .workspaces_dir
    .canonicalize()
    .map_err(|err| format!("Cannot resolve workspaces root: {err}"))?;
  let workspace_paths = repos::list_workspace_paths(db.pool(), &repo_id)
    .await
    .map_err(|err| err.to_string())?;
  for workspace_path in workspace_paths {
    let candidate = PathBuf::from(&workspace_path);
    let resolved = match candidate.canonicalize() {
      Ok(path) => path,
      Err(_) if !candidate.exists() => continue,
      Err(err) => {
        return Err(format!(
          "Cannot resolve workspace path {}: {}",
          candidate.display(),
          err
        ));
      }
    };
    if !resolved.starts_with(&workspace_root) {
      return Err(format!(
        "Refusing to delete workspace outside managed directory: {}",
        resolved.display()
      ));
    }
    if let Err(err) = fs::remove_dir_all(&resolved) {
      if err.kind() != std::io::ErrorKind::NotFound {
        return Err(err.to_string());
      }
    }
  }
  repos::delete_repo(db.pool(), &repo_id)
    .await
    .map_err(|err| err.to_string())
}

#[allow(non_snake_case)]
#[tauri::command]
async fn listWorkspaces(
  db: tauri::State<'_, Database>,
) -> Result<Vec<workspace::WorkspaceRecord>, String> {
  workspace::list_workspaces(db.pool())
    .await
    .map_err(|err| err.to_string())
}

#[allow(non_snake_case)]
#[tauri::command]
async fn createWorkspace(
  db: tauri::State<'_, Database>,
  paths: tauri::State<'_, AppPaths>,
  payload: CreateWorkspaceRequest,
) -> Result<workspace::WorkspaceRecord, String> {
  let (repo_id, branch_override) = match payload {
    CreateWorkspaceRequest::Default { repo_id } => (repo_id, None),
    CreateWorkspaceRequest::Branch { repo_id, branch } => (repo_id, Some(branch)),
  };

  let repo = repos::get_repo_by_id(db.pool(), &repo_id)
    .await
    .map_err(|err| err.to_string())?;
  let branch = branch_override.unwrap_or_else(|| repo.default_branch.clone());
  let branch = branch.trim().to_string();
  if branch.is_empty() {
    return Err("Branch name is required".to_string());
  }

  let repo_root = PathBuf::from(&repo.root_path);
  let exists = branch_exists(&repo_root, &branch).map_err(|err| err.to_string())?;
  if !exists {
    return Err(format!("Branch does not exist: {branch}"));
  }

  if let Some(existing_id) =
    workspace::find_active_workspace_for_branch(db.pool(), &repo_id, &branch)
      .await
      .map_err(|err| err.to_string())?
  {
    return Err(format!(
      "Workspace already exists for branch {branch} (id: {existing_id})"
    ));
  }

  let id = workspace::generate_id(db.pool())
    .await
    .map_err(|err| err.to_string())?;
  let directory_name = workspace::build_directory_name(&repo.name, &branch, &id);
  let workspace_path = paths.workspaces_dir.join(&directory_name);
  if workspace_path.exists() {
    return Err(format!(
      "Workspace path already exists: {}",
      workspace_path.display()
    ));
  }

  let base_port = workspace::allocate_base_port(db.pool())
    .await
    .map_err(|err| err.to_string())?;

  create_worktree(&repo_root, &workspace_path, &branch).map_err(|err| err.to_string())?;

  if let Err(err) = ensure_context_dirs(&workspace_path) {
    let _ = remove_worktree(&repo_root, &workspace_path);
    let _ = fs::remove_dir_all(&workspace_path);
    return Err(err);
  }

  let env_vars_raw = settings::get_env_vars(db.pool())
    .await
    .map_err(|err| err.to_string())?;
  let setup_log_path = repo
    .scripts_setup
    .as_ref()
    .filter(|value| !value.trim().is_empty())
    .map(|_| build_log_path(&paths, "setup", &id));
  if let (Some(script), Some(log_path)) = (&repo.scripts_setup, &setup_log_path) {
    let envs = build_workspace_env(
      &repo,
      &id,
      Some(&directory_name),
      &workspace_path,
      Some(base_port),
      &env_vars_raw,
    );
    if let Err(err) = run_workspace_script_with_log(script, &workspace_path, &envs, log_path) {
      let _ = remove_worktree(&repo_root, &workspace_path);
      let _ = fs::remove_dir_all(&workspace_path);
      return Err(err);
    }
  }
  let setup_log_path = setup_log_path.map(|path| path.to_string_lossy().to_string());

  let new_workspace = workspace::NewWorkspace {
    id: id.clone(),
    repo_id: repo_id.clone(),
    branch: branch.clone(),
    directory_name: Some(directory_name),
    path: workspace_path.to_string_lossy().to_string(),
    state: workspace::active_state().to_string(),
    base_port: Some(base_port),
    setup_log_path,
    archive_log_path: None,
    intended_target_branch: Some(repo.default_branch.clone()),
    pr_number: None,
    pr_url: None,
    pr_last_comment_id: None,
  };

  match workspace::insert_workspace(db.pool(), new_workspace).await {
    Ok(record) => Ok(record),
    Err(err) => {
      let _ = remove_worktree(&repo_root, &workspace_path);
      let _ = fs::remove_dir_all(&workspace_path);
      let message = match err {
        DbError::Conflict(details) => details,
        other => other.to_string(),
      };
      Err(message)
    }
  }
}

#[allow(non_snake_case)]
#[tauri::command]
async fn archiveWorkspace(
  db: tauri::State<'_, Database>,
  paths: tauri::State<'_, AppPaths>,
  workspace_id: String,
  allow_script: bool,
) -> Result<(), String> {
  let workspace_record = workspace::get_workspace(db.pool(), &workspace_id)
    .await
    .map_err(|err| err.to_string())?;
  if workspace_record.state == workspace::archived_state() {
    return Ok(());
  }

  let repo = repos::get_repo_by_id(db.pool(), &workspace_record.repo_id)
    .await
    .map_err(|err| err.to_string())?;
  let workspace_path = PathBuf::from(&workspace_record.path);
  let workspace_root = paths
    .workspaces_dir
    .canonicalize()
    .map_err(|err| format!("Cannot resolve workspaces root: {err}"))?;
  let resolved_workspace = match workspace_path.canonicalize() {
    Ok(path) => path,
    Err(_err) if !workspace_path.exists() => workspace_path.clone(),
    Err(err) => return Err(format!("Cannot resolve workspace path: {err}")),
  };
  if !resolved_workspace.starts_with(&workspace_root) {
    return Err(format!(
      "Refusing to delete workspace outside managed directory: {}",
      resolved_workspace.display()
    ));
  }
  if let Some(script) = repo
    .scripts_archive
    .as_ref()
    .filter(|value| !value.trim().is_empty())
  {
    if !allow_script {
      return Err("Archive script requires confirmation.".to_string());
    }
    let env_vars_raw = settings::get_env_vars(db.pool())
      .await
      .map_err(|err| err.to_string())?;
    let archive_log_path = build_log_path(&paths, "archive", &workspace_id);
    let archive_log_path_str = archive_log_path.to_string_lossy().to_string();
    workspace::set_workspace_archive_log_path(db.pool(), &workspace_id, &archive_log_path_str)
      .await
      .map_err(|err| err.to_string())?;
    let envs = build_workspace_env(
      &repo,
      &workspace_id,
      workspace_record.directory_name.as_deref(),
      &workspace_path,
      workspace_record.base_port,
      &env_vars_raw,
    );
    run_workspace_script_with_log(script, &workspace_path, &envs, &archive_log_path)?;
  }

  if workspace_path.exists() {
    remove_worktree(&PathBuf::from(&repo.root_path), &workspace_path)
      .map_err(|err| err.to_string())?;
  }
  if let Err(err) = fs::remove_dir_all(&workspace_path) {
    if err.kind() != std::io::ErrorKind::NotFound {
      return Err(err.to_string());
    }
  }

  workspace::set_workspace_state(db.pool(), &workspace_id, workspace::archived_state())
    .await
    .map_err(|err| err.to_string())
}

#[allow(non_snake_case)]
#[tauri::command]
async fn unarchiveWorkspace(
  db: tauri::State<'_, Database>,
  paths: tauri::State<'_, AppPaths>,
  workspace_id: String,
) -> Result<(), String> {
  let workspace_record = workspace::get_workspace(db.pool(), &workspace_id)
    .await
    .map_err(|err| err.to_string())?;
  if workspace_record.state == workspace::active_state() {
    return Err("Workspace is already active".to_string());
  }

  if let Some(existing_id) = workspace::find_active_workspace_for_branch(
    db.pool(),
    &workspace_record.repo_id,
    &workspace_record.branch,
  )
  .await
  .map_err(|err| err.to_string())?
  {
    return Err(format!(
      "Workspace already exists for branch {} (id: {})",
      workspace_record.branch, existing_id
    ));
  }

  let repo = repos::get_repo_by_id(db.pool(), &workspace_record.repo_id)
    .await
    .map_err(|err| err.to_string())?;
  let repo_root = PathBuf::from(&repo.root_path);
  let exists = branch_exists(&repo_root, &workspace_record.branch)
    .map_err(|err| err.to_string())?;
  if !exists {
    return Err(format!(
      "Branch does not exist: {}",
      workspace_record.branch
    ));
  }
  let workspace_path = PathBuf::from(&workspace_record.path);
  if workspace_path.exists() {
    return Err(format!(
      "Workspace path already exists: {}",
      workspace_path.display()
    ));
  }

  if !workspace_path.starts_with(&paths.workspaces_dir) {
    return Err(format!(
      "Refusing to create workspace outside managed directory: {}",
      workspace_path.display()
    ));
  }

  create_worktree(&repo_root, &workspace_path, &workspace_record.branch)
    .map_err(|err| err.to_string())?;
  if let Err(err) = ensure_context_dirs(&workspace_path) {
    let _ = remove_worktree(&repo_root, &workspace_path);
    let _ = fs::remove_dir_all(&workspace_path);
    return Err(err);
  }

  workspace::set_workspace_state(db.pool(), &workspace_id, workspace::active_state())
    .await
    .map_err(|err| err.to_string())
}

#[allow(non_snake_case)]
#[tauri::command]
async fn pinWorkspace(
  db: tauri::State<'_, Database>,
  workspace_id: String,
  pinned: bool,
) -> Result<(), String> {
  workspace::set_workspace_pinned(db.pool(), &workspace_id, pinned)
    .await
    .map_err(|err| err.to_string())
}

#[allow(non_snake_case)]
#[tauri::command]
async fn markWorkspaceUnread(
  db: tauri::State<'_, Database>,
  workspace_id: String,
  unread: bool,
) -> Result<(), String> {
  workspace::set_workspace_unread(db.pool(), &workspace_id, unread)
    .await
    .map_err(|err| err.to_string())
}

#[allow(non_snake_case)]
#[tauri::command]
async fn listSessions(db: tauri::State<'_, Database>) -> Result<Vec<SessionRecord>, String> {
  sessions::list_sessions(db.pool())
    .await
    .map_err(|err| err.to_string())
}

#[allow(non_snake_case)]
#[tauri::command]
async fn createSession(
  db: tauri::State<'_, Database>,
  payload: CreateSessionRequest,
) -> Result<SessionRecord, String> {
  let agent_type = payload.agent_type.to_lowercase();
  if agent_type != "claude" && agent_type != "codex" {
    return Err("Unsupported agent type".to_string());
  }
  let _workspace = workspace::get_workspace(db.pool(), &payload.workspace_id)
    .await
    .map_err(|err| err.to_string())?;

  let count = sessions::count_workspace_sessions(db.pool(), &payload.workspace_id)
    .await
    .map_err(|err| err.to_string())?;
  let title = Some(format!("Chat {}", count + 1));

  sessions::insert_session(
    db.pool(),
    sessions::NewSession {
      workspace_id: payload.workspace_id,
      title,
      agent_type,
      model: payload.model,
      status: "idle".to_string(),
    },
  )
  .await
  .map_err(|err| err.to_string())
}

#[allow(non_snake_case)]
#[tauri::command]
async fn updateSessionModel(
  db: tauri::State<'_, Database>,
  session_id: String,
  model: Option<String>,
) -> Result<(), String> {
  sessions::set_session_model(db.pool(), &session_id, model.as_deref())
    .await
    .map_err(|err| err.to_string())
}

#[allow(non_snake_case)]
#[tauri::command]
async fn deleteSession(
  db: tauri::State<'_, Database>,
  sidecar: tauri::State<'_, SidecarManager>,
  session_id: String,
) -> Result<(), String> {
  sidecar.close_session(&session_id).await;
  sessions::delete_session(db.pool(), &session_id)
    .await
    .map_err(|err| err.to_string())
}

#[allow(non_snake_case)]
#[tauri::command]
async fn listSessionMessages(
  db: tauri::State<'_, Database>,
  session_id: String,
) -> Result<Vec<SessionMessageRecord>, String> {
  sessions::list_session_messages(db.pool(), &session_id)
    .await
    .map_err(|err| err.to_string())
}

#[allow(non_snake_case)]
#[tauri::command]
async fn listSessionAttachments(
  db: tauri::State<'_, Database>,
  session_id: String,
) -> Result<Vec<AttachmentRecord>, String> {
  attachments::list_session_attachments(db.pool(), &session_id)
    .await
    .map_err(|err| err.to_string())
}

#[allow(non_snake_case)]
#[tauri::command]
async fn createAttachment(
  db: tauri::State<'_, Database>,
  payload: CreateAttachmentRequest,
) -> Result<AttachmentRecord, String> {
  let session = sessions::get_session(db.pool(), &payload.session_id)
    .await
    .map_err(|err| err.to_string())?;
  let workspace_record = workspace::get_workspace(db.pool(), &session.workspace_id)
    .await
    .map_err(|err| err.to_string())?;
  let workspace_path = PathBuf::from(&workspace_record.path);
  ensure_context_dirs(&workspace_path)?;
  let attachment_id = attachments::generate_attachment_id(db.pool())
    .await
    .map_err(|err| err.to_string())?;
  let sanitized = sanitize_filename(&payload.file_name);
  let relative_path = PathBuf::from(".context")
    .join("attachments")
    .join(format!("{attachment_id}-{sanitized}"));
  let absolute_path = workspace_path.join(&relative_path);

  if let Some(source_path) = payload.source_path.as_ref() {
    let source = PathBuf::from(source_path);
    if !source.is_file() {
      return Err(format!("Attachment source is not a file: {source_path}"));
    }
    fs::copy(&source, &absolute_path).map_err(|err| err.to_string())?;
  } else if let Some(bytes) = payload.bytes.as_ref() {
    fs::write(&absolute_path, bytes).map_err(|err| err.to_string())?;
  } else {
    return Err("Attachment payload is missing source data".to_string());
  }

  attachments::insert_attachment(
    db.pool(),
    attachments::NewAttachment {
      id: attachment_id,
      session_id: session.id,
      session_message_id: None,
      attachment_type: "file".to_string(),
      title: Some(payload.file_name),
      path: Some(relative_path.to_string_lossy().to_string()),
      mime_type: payload.mime_type,
      is_draft: true,
    },
  )
  .await
  .map_err(|err| err.to_string())
}

#[allow(non_snake_case)]
#[tauri::command]
async fn deleteAttachment(
  db: tauri::State<'_, Database>,
  attachment_id: String,
) -> Result<(), String> {
  let attachment = attachments::get_attachment(db.pool(), &attachment_id)
    .await
    .map_err(|err| err.to_string())?;
  if let Some(path) = attachment.path {
    let session = sessions::get_session(db.pool(), &attachment.session_id)
      .await
      .map_err(|err| err.to_string())?;
    let workspace_record = workspace::get_workspace(db.pool(), &session.workspace_id)
      .await
      .map_err(|err| err.to_string())?;
    let absolute_path = PathBuf::from(&workspace_record.path).join(path);
    if absolute_path.exists() {
      fs::remove_file(&absolute_path).map_err(|err| err.to_string())?;
    }
  }
  attachments::delete_attachment(db.pool(), &attachment_id)
    .await
    .map_err(|err| err.to_string())
}

#[allow(non_snake_case)]
#[tauri::command]
async fn sendSessionMessage(
  db: tauri::State<'_, Database>,
  sidecar: tauri::State<'_, SidecarManager>,
  payload: SendSessionMessageRequest,
) -> Result<SessionMessageRecord, String> {
  let prompt = payload.prompt.trim();
  if prompt.is_empty() {
    return Err("Prompt is required".to_string());
  }
  let session = sessions::get_session(db.pool(), &payload.session_id)
    .await
    .map_err(|err| err.to_string())?;
  let workspace_record = workspace::get_workspace(db.pool(), &session.workspace_id)
    .await
    .map_err(|err| err.to_string())?;
  let env_vars_raw = settings::get_env_vars(db.pool())
    .await
    .map_err(|err| err.to_string())?;

  let message_id = sessions::generate_message_id(db.pool())
    .await
    .map_err(|err| err.to_string())?;

  let next_turn_id = sessions::next_turn_id(db.pool(), &session.id)
    .await
    .map_err(|err| err.to_string())?;
  let checkpoint_id = if session.agent_type == "claude" {
    let checkpoint_id = format!("session-{}-turn-{}-user", session.id, next_turn_id);
    let workspace_path = PathBuf::from(&workspace_record.path);
    match create_checkpoint(&workspace_path, &checkpoint_id) {
      Ok(CheckpointOutcome::Created) => Some(checkpoint_id),
      Ok(CheckpointOutcome::Skipped { reason }) => {
        eprintln!(
          "[checkpoint] skipped for session {} turn {}: {}",
          session.id, next_turn_id, reason
        );
        None
      }
      Err(err) => {
        eprintln!(
          "[checkpoint] failed for session {} turn {}: {}",
          session.id, next_turn_id, err
        );
        None
      }
    }
  } else {
    None
  };

  let user_message = sessions::insert_session_message(
    db.pool(),
    sessions::NewSessionMessage {
      id: message_id,
      session_id: session.id.clone(),
      turn_id: next_turn_id,
      role: "user".to_string(),
      content: prompt.to_string(),
      metadata_json: None,
      checkpoint_id,
    },
  )
  .await
  .map_err(|err| err.to_string())?;
  let turn_id = user_message.turn_id;

  if let Some(attachment_ids) = payload.attachment_ids.as_ref() {
    if !attachment_ids.is_empty() {
      attachments::attach_attachments_to_message(
        db.pool(),
        &session.id,
        &user_message.id,
        attachment_ids,
      )
      .await
      .map_err(|err| err.to_string())?;
    }
  }

  let mut additional_directories: Vec<String> = Vec::new();
  if let Some(linked_ids) = workspace_record.linked_workspace_ids.clone() {
    let mut seen = HashSet::new();
    for linked_id in linked_ids {
      if !seen.insert(linked_id.clone()) {
        continue;
      }
      match workspace::get_workspace(db.pool(), &linked_id).await {
        Ok(linked_workspace) => {
          if linked_workspace.path != workspace_record.path {
            additional_directories.push(linked_workspace.path);
          }
        }
        Err(err) => {
          eprintln!(
            "[sendSessionMessage] skipping linked workspace {}: {}",
            linked_id, err
          );
        }
      }
    }
  }

  let options = build_session_query_options(
    &session,
    &workspace_record.path,
    payload.permission_mode.clone(),
    &env_vars_raw,
    &additional_directories,
    turn_id,
  );
  if let Err(err) = sidecar
    .send_query(&session.id, &session.agent_type, prompt, options, turn_id)     
    .await
  {
    let _ = sessions::set_session_status(db.pool(), &session.id, "error").await;
    return Err(err);
  }
  sessions::set_session_status(db.pool(), &session.id, "running")
    .await
    .map_err(|err| err.to_string())?;

  Ok(user_message)
}

fn build_session_query_options(
  session: &sessions::SessionRecord,
  workspace_path: &str,
  permission_mode: Option<String>,
  env_vars_raw: &str,
  additional_directories: &[String],
  turn_id: i64,
) -> Value {
  let mut options = serde_json::Map::new();
  options.insert("cwd".to_string(), Value::String(workspace_path.to_string()));
  if let Some(model) = session
    .model
    .clone()
    .filter(|value| !value.trim().is_empty())
  {
    options.insert("model".to_string(), Value::String(model));
  }
  if let Some(permission_mode) = permission_mode.filter(|value| !value.trim().is_empty()) {
    options.insert(
      "permissionMode".to_string(),
      Value::String(permission_mode),
    );
  }
  match session.agent_type.as_str() {
    "claude" => {
      if let Some(resume) = session
        .claude_session_id
        .as_ref()
        .filter(|value| !value.trim().is_empty())
      {
        options.insert("resume".to_string(), Value::String(resume.clone()));
      }
    }
    "codex" => {
      if let Some(resume) = session
        .codex_session_id
        .as_ref()
        .filter(|value| !value.trim().is_empty())
      {
        options.insert("resume".to_string(), Value::String(resume.clone()));
      }
    }
    _ => {}
  }
  if !env_vars_raw.trim().is_empty() {
    options.insert(
      "claudeEnvVars".to_string(),
      Value::String(env_vars_raw.to_string()),
    );
    let parsed = parse_env_vars(env_vars_raw);
    if !parsed.is_empty() {
      let mut env_map = serde_json::Map::new();
      for (key, value) in parsed {
        env_map.insert(key, Value::String(value));
      }
      options.insert("conductorEnv".to_string(), Value::Object(env_map));
    }
  }
  if !additional_directories.is_empty() {
    options.insert(
      "additionalDirectories".to_string(),
      json!(additional_directories),
    );
  }
  options.insert("turnId".to_string(), json!(turn_id));
  Value::Object(options)
}

#[allow(non_snake_case)]
#[tauri::command]
async fn cancelSession(
  db: tauri::State<'_, Database>,
  sidecar: tauri::State<'_, SidecarManager>,
  session_id: String,
) -> Result<(), String> {
  let session = sessions::get_session(db.pool(), &session_id)
    .await
    .map_err(|err| err.to_string())?;
  sidecar
    .cancel(&session.id, &session.agent_type)
    .await?;
  sessions::set_session_status(db.pool(), &session.id, "idle")
    .await
    .map_err(|err| err.to_string())
}

#[allow(non_snake_case)]
#[tauri::command]
async fn resetSessionToTurn(
  db: tauri::State<'_, Database>,
  sidecar: tauri::State<'_, SidecarManager>,
  payload: ResetSessionToTurnRequest,
) -> Result<(), String> {
  let session = sessions::get_session(db.pool(), &payload.session_id)
    .await
    .map_err(|err| err.to_string())?;
  let checkpoint = sessions::get_session_message_checkpoint(
    db.pool(),
    &session.id,
    payload.turn_id,
  )
  .await
  .map_err(|err| err.to_string())?;
  let Some(checkpoint) = checkpoint else {
    return Err("Checkpoint not found for this turn".to_string());
  };
  if checkpoint.role != "user" {
    return Err("Reset is only supported for user messages".to_string());
  }
  let Some(checkpoint_id) = checkpoint
    .checkpoint_id
    .filter(|value| !value.trim().is_empty())
  else {
    return Err("Checkpoint is unavailable for this turn".to_string());
  };
  let expected_workspace_id = session.workspace_id.clone();
  let expected_status = session.status.clone();

  let workspace_sessions = sessions::list_workspace_sessions(db.pool(), &session.workspace_id)
    .await
    .map_err(|err| err.to_string())?;
  if workspace_sessions.iter().any(|item| {
    item.id != session.id && matches!(item.status.as_str(), "running")
  }) {
    return Err("Another session is running in this workspace".to_string());
  }

  if matches!(session.status.as_str(), "running") {
    sidecar
      .cancel(&session.id, &session.agent_type)
      .await?;
  }
  sidecar.close_session(&session.id).await;

  let refreshed_session = sessions::get_session(db.pool(), &session.id)
    .await
    .map_err(|_| "Session no longer exists".to_string())?;
  if refreshed_session.workspace_id != expected_workspace_id {
    return Err("Session workspace changed".to_string());
  }
  if refreshed_session.status != expected_status {
    return Err("Session status changed".to_string());
  }
  let refreshed_workspace = workspace::get_workspace(db.pool(), &expected_workspace_id)
    .await
    .map_err(|_| "Workspace no longer exists".to_string())?;
  let next_turn_id = sessions::next_turn_id(db.pool(), &session.id)
    .await
    .map_err(|err| err.to_string())?;
  let max_turn_id = next_turn_id.saturating_sub(1);
  if payload.turn_id <= 0 || payload.turn_id > max_turn_id {
    return Err("Invalid turn_id".to_string());
  }
  let refreshed_sessions =
    sessions::list_workspace_sessions(db.pool(), &expected_workspace_id)
      .await
      .map_err(|err| err.to_string())?;
  if refreshed_sessions.iter().any(|item| {
    item.id != session.id && matches!(item.status.as_str(), "running")
  }) {
    return Err("Conflicting running session".to_string());
  }

  let workspace_path = PathBuf::from(&refreshed_workspace.path);
  let rollback_checkpoint_id = {
    let stamp = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .map(|duration| duration.as_millis())
      .unwrap_or(0);
    format!("session-{}-turn-{}-rollback-{}", session.id, payload.turn_id, stamp)
  };
  // Create a rollback checkpoint so we can restore the current workspace if DB reset fails.
  // This is best-effort: failure here should not block the reset attempt.
  let rollback_checkpoint = match create_checkpoint(&workspace_path, &rollback_checkpoint_id) {
    Ok(CheckpointOutcome::Created) => Some(rollback_checkpoint_id),
    Ok(CheckpointOutcome::Skipped { reason }) => {
      eprintln!(
        "[checkpoint] rollback skipped for session {} turn {}: {}",
        session.id, payload.turn_id, reason
      );
      None
    }
    Err(err) => {
      eprintln!(
        "[checkpoint] rollback checkpoint failed for session {} turn {}: {}",
        session.id, payload.turn_id, err
      );
      None
    }
  };
  // Restore the target checkpoint. If this fails, we must abort the reset.
  restore_checkpoint(&workspace_path, &checkpoint_id).map_err(|err| err.to_string())?;
  // Attempt DB reset. If it fails, try to restore the rollback checkpoint to avoid
  // leaving the workspace and DB out of sync. Rollback failures are logged and may
  // leave the workspace reverted while DB state remains unchanged.
  if let Err(err) = sessions::reset_session_to_turn(db.pool(), &session.id, payload.turn_id).await
  {
    if let Some(rollback_id) = rollback_checkpoint.as_deref() {
      if let Err(rollback_err) = restore_checkpoint(&workspace_path, rollback_id) {
        eprintln!(
          "[checkpoint] rollback restore failed for session {} turn {}: {}",
          session.id, payload.turn_id, rollback_err
        );
      }
      // Cleanup failure here leaves the rollback ref behind but does not affect workspace.
      if let Err(cleanup_err) = delete_checkpoint(&workspace_path, rollback_id) {
        eprintln!(
          "[checkpoint] rollback cleanup failed for session {} turn {}: {}",
          session.id, payload.turn_id, cleanup_err
        );
      }
    }
    return Err(format!(
      "Reset failed after restoring checkpoint; workspace may be reverted: {err}"
    ));
  }
  // Cleanup rollback checkpoint after successful DB reset. Failure leaves a stale ref.
  if let Some(rollback_id) = rollback_checkpoint.as_deref() {
    if let Err(cleanup_err) = delete_checkpoint(&workspace_path, rollback_id) {
      eprintln!(
        "[checkpoint] rollback cleanup failed for session {} turn {}: {}",
        session.id, payload.turn_id, cleanup_err
      );
    }
  }

  Ok(())
}

#[allow(non_snake_case)]
#[tauri::command]
async fn updatePermissionMode(
  db: tauri::State<'_, Database>,
  sidecar: tauri::State<'_, SidecarManager>,
  session_id: String,
  permission_mode: String,
) -> Result<(), String> {
  let session = sessions::get_session(db.pool(), &session_id)
    .await
    .map_err(|err| err.to_string())?;
  sidecar
    .update_permission_mode(&session_id, &session.agent_type, &permission_mode)
    .await
}

#[allow(non_snake_case)]
#[tauri::command]
async fn respondAskUserQuestion(
  sidecar: tauri::State<'_, SidecarManager>,
  payload: ResolveAskUserQuestionRequest,
) -> Result<(), String> {
  let response = json!({ "answers": payload.answers });
  sidecar
    .resolve_frontend_request(&payload.request_id, response)
    .await
}

#[allow(non_snake_case)]
#[tauri::command]
async fn respondExitPlanMode(
  sidecar: tauri::State<'_, SidecarManager>,
  payload: ResolveExitPlanModeRequest,
) -> Result<(), String> {
  let response = json!({ "approved": payload.approved, "turnId": payload.turn_id });
  sidecar
    .resolve_frontend_request(&payload.request_id, response)
    .await
}

#[allow(non_snake_case)]
#[tauri::command]
async fn setWorkspaceSparseCheckout(
  db: tauri::State<'_, Database>,
  workspace_id: String,
  patterns: Vec<String>,
) -> Result<(), String> {
  let workspace_record = workspace::get_workspace(db.pool(), &workspace_id)
    .await
    .map_err(|err| err.to_string())?;
  set_sparse_checkout(Path::new(&workspace_record.path), &patterns)
    .map_err(|err| err.to_string())
}

#[allow(non_snake_case)]
#[tauri::command]
async fn setWorkspaceLinkedWorkspaces(
  db: tauri::State<'_, Database>,
  workspace_id: String,
  linked_workspace_ids: Vec<String>,
) -> Result<(), String> {
  let mut unique_ids: Vec<String> = linked_workspace_ids
    .into_iter()
    .map(|id| id.trim().to_string())
    .filter(|id| !id.is_empty())
    .collect();
  unique_ids.sort();
  unique_ids.dedup();
  if unique_ids.iter().any(|id| id == &workspace_id) {
    return Err("Workspace cannot link to itself.".to_string());
  }
  for id in &unique_ids {
    workspace::get_workspace(db.pool(), id)
      .await
      .map_err(|err| err.to_string())?;
  }
  let linked_json = if unique_ids.is_empty() {
    None
  } else {
    Some(
      serde_json::to_string(&unique_ids).map_err(|err| err.to_string())?,
    )
  };
  workspace::set_workspace_linked_workspace_ids(
    db.pool(),
    &workspace_id,
    linked_json.as_deref(),
  )
  .await
  .map_err(|err| err.to_string())
}

#[allow(non_snake_case)]
#[tauri::command]
async fn listWorkspaceFiles(
  db: tauri::State<'_, Database>,
  paths: tauri::State<'_, AppPaths>,
  workspace_id: String,
) -> Result<Vec<String>, String> {
  let workspace_record = workspace::get_workspace(db.pool(), &workspace_id)
    .await
    .map_err(|err| err.to_string())?;
  let root = resolve_workspace_root(&paths, Path::new(&workspace_record.path))?;
  tauri::async_runtime::spawn_blocking(move || list_workspace_files(&root))
    .await
    .map_err(|err| err.to_string())?
}

#[allow(non_snake_case)]
#[tauri::command]
async fn readWorkspaceFile(
  db: tauri::State<'_, Database>,
  paths: tauri::State<'_, AppPaths>,
  workspace_id: String,
  path: String,
) -> Result<FilePreview, String> {
  let workspace_record = workspace::get_workspace(db.pool(), &workspace_id)
    .await
    .map_err(|err| err.to_string())?;
  let root = resolve_workspace_root(&paths, Path::new(&workspace_record.path))?;
  tauri::async_runtime::spawn_blocking(move || read_workspace_file(&root, &path))
    .await
    .map_err(|err| err.to_string())?
}

#[allow(non_snake_case)]
#[tauri::command]
async fn getWorkspaceNotes(
  db: tauri::State<'_, Database>,
  workspace_id: String,
) -> Result<String, String> {
  let workspace_record = workspace::get_workspace(db.pool(), &workspace_id)
    .await
    .map_err(|err| err.to_string())?;
  read_notes(Path::new(&workspace_record.path))
}

#[allow(non_snake_case)]
#[tauri::command]
async fn setWorkspaceNotes(
  db: tauri::State<'_, Database>,
  workspace_id: String,
  content: String,
) -> Result<(), String> {
  let workspace_record = workspace::get_workspace(db.pool(), &workspace_id)
    .await
    .map_err(|err| err.to_string())?;
  write_notes(Path::new(&workspace_record.path), &content)
}

#[allow(non_snake_case)]
#[tauri::command]
async fn getWorkspaceTodos(
  db: tauri::State<'_, Database>,
  workspace_id: String,
) -> Result<Vec<ManualTodoItem>, String> {
  let workspace_record = workspace::get_workspace(db.pool(), &workspace_id)
    .await
    .map_err(|err| err.to_string())?;
  read_todos(Path::new(&workspace_record.path))
}

#[allow(non_snake_case)]
#[tauri::command]
async fn setWorkspaceTodos(
  db: tauri::State<'_, Database>,
  workspace_id: String,
  items: Vec<ManualTodoItem>,
) -> Result<(), String> {
  validate_todos(&items)?;
  let workspace_record = workspace::get_workspace(db.pool(), &workspace_id)
    .await
    .map_err(|err| err.to_string())?;
  write_todos(Path::new(&workspace_record.path), &items)
}

#[allow(non_snake_case)]
#[tauri::command]
async fn getWorkspaceGitStatus(
  db: tauri::State<'_, Database>,
  workspace_id: String,
) -> Result<Vec<GitStatusEntry>, String> {
  let workspace_record = workspace::get_workspace(db.pool(), &workspace_id)
    .await
    .map_err(|err| err.to_string())?;
  let workspace_path = PathBuf::from(workspace_record.path);
  tauri::async_runtime::spawn_blocking(move || list_status(&workspace_path))
    .await
    .map_err(|err| err.to_string())?
    .map_err(|err| err.to_string())
}

#[allow(non_snake_case)]
#[tauri::command]
async fn getBranchSyncStatus(
  db: tauri::State<'_, Database>,
  workspace_id: String,
) -> Result<git::BranchSyncStatus, String> {
  let workspace_record = workspace::get_workspace(db.pool(), &workspace_id)
    .await
    .map_err(|err| err.to_string())?;
  let workspace_path = PathBuf::from(workspace_record.path);
  tauri::async_runtime::spawn_blocking(move || git::branch_sync_status(&workspace_path))
    .await
    .map_err(|err| err.to_string())?
    .map_err(|err| err.to_string())
}

#[allow(non_snake_case)]
#[tauri::command]
async fn getWorkspaceDiff(
  db: tauri::State<'_, Database>,
  payload: WorkspaceDiffRequest,
) -> Result<WorkspaceDiffResponse, String> {
  let workspace_record = workspace::get_workspace(db.pool(), &payload.workspace_id)
    .await
    .map_err(|err| err.to_string())?;
  let workspace_path = PathBuf::from(workspace_record.path);
  let file_path = payload.path.as_ref().map(PathBuf::from);
  let stat = payload.stat.unwrap_or(false);
  tauri::async_runtime::spawn_blocking(move || {
    git_diff(&workspace_path, file_path.as_deref(), stat)
  })
  .await
  .map_err(|err| err.to_string())?
  .map(|diff| WorkspaceDiffResponse { diff })
  .map_err(|err| err.to_string())
}

#[allow(non_snake_case)]
#[tauri::command]
async fn getGithubAuthStatus() -> Result<GithubAuthStatus, String> {
  tauri::async_runtime::spawn_blocking(detect_github_auth_status)
    .await
    .map_err(|err| err.to_string())
}

#[allow(non_snake_case)]
#[tauri::command]
async fn getSpotlightStatus(
  spotlight: tauri::State<'_, SpotlightManager>,
  workspace_id: String,
) -> Result<bool, String> {
  Ok(spotlight.is_active(&workspace_id))
}

#[allow(non_snake_case)]
#[tauri::command]
async fn enableSpotlight(
  db: tauri::State<'_, Database>,
  spotlight: tauri::State<'_, SpotlightManager>,
  workspace_id: String,
) -> Result<(), String> {
  let workspace_record = workspace::get_workspace(db.pool(), &workspace_id)
    .await
    .map_err(|err| err.to_string())?;
  let repo = repos::get_repo_by_id(db.pool(), &workspace_record.repo_id)
    .await
    .map_err(|err| err.to_string())?;
  let workspace_path = PathBuf::from(&workspace_record.path);
  let repo_root = PathBuf::from(&repo.root_path);
  spotlight.enable(&workspace_id, workspace_path, repo_root)
}

#[allow(non_snake_case)]
#[tauri::command]
async fn disableSpotlight(
  spotlight: tauri::State<'_, SpotlightManager>,
  workspace_id: String,
) -> Result<(), String> {
  spotlight.disable(&workspace_id)
}

#[allow(non_snake_case)]
#[tauri::command]
async fn listRepoBranches(
  db: tauri::State<'_, Database>,
  repo_id: String,
) -> Result<Vec<String>, String> {
  let repo = repos::get_repo_by_id(db.pool(), &repo_id)
    .await
    .map_err(|err| err.to_string())?;
  let root = PathBuf::from(&repo.root_path);
  let default_branch = repo.default_branch.clone();
  let mut branches = tauri::async_runtime::spawn_blocking(move || list_branches(&root))
    .await
    .map_err(|err| err.to_string())?
    .map_err(|err| err.to_string())?;
  if !default_branch.trim().is_empty()
    && !branches.iter().any(|branch| branch == &default_branch)
  {
    branches.push(default_branch);
  }
  branches.sort();
  Ok(branches)
}

#[allow(non_snake_case)]
#[tauri::command]
async fn setWorkspaceTargetBranch(
  db: tauri::State<'_, Database>,
  workspace_id: String,
  target_branch: Option<String>,
) -> Result<(), String> {
  let normalized = target_branch
    .as_deref()
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(|value| value.to_string());
  let workspace_record = workspace::get_workspace(db.pool(), &workspace_id)
    .await
    .map_err(|err| err.to_string())?;
  if let Some(branch) = normalized.as_ref() {
    let workspace_path = PathBuf::from(&workspace_record.path);
    let branch_value = branch.clone();
    let exists = tauri::async_runtime::spawn_blocking(move || {
      branch_exists(&workspace_path, &branch_value)
    })
    .await
    .map_err(|err| err.to_string())?
    .map_err(|err| err.to_string())?;
    if !exists {
      return Err(format!("Target branch does not exist: {branch}"));
    }
  }
  workspace::set_workspace_target_branch(
    db.pool(),
    &workspace_id,
    normalized.as_deref(),
  )
  .await
  .map_err(|err| err.to_string())
}

#[allow(non_snake_case)]
#[tauri::command]
async fn createPullRequest(
  db: tauri::State<'_, Database>,
  workspace_id: String,
) -> Result<PullRequestInfo, String> {
  let workspace_record = workspace::get_workspace(db.pool(), &workspace_id)
    .await
    .map_err(|err| err.to_string())?;
  let repo = repos::get_repo_by_id(db.pool(), &workspace_record.repo_id)
    .await
    .map_err(|err| err.to_string())?;
  let repo_slug = repo
    .remote_url
    .as_deref()
    .and_then(parse_github_repo_slug)
    .ok_or_else(|| "Repository remote is not a GitHub URL.".to_string())?;
  let head_branch = workspace_record.branch.clone();
  let base_branch = workspace_record
    .intended_target_branch
    .as_deref()
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .unwrap_or(repo.default_branch.as_str())
    .to_string();
  let workspace_path = PathBuf::from(&workspace_record.path);
  let repo_slug_clone = repo_slug.clone();
  let head_branch_clone = head_branch.clone();
  let base_branch_clone = base_branch.clone();
  let info = tauri::async_runtime::spawn_blocking(move || -> Result<PullRequestInfo, String> {
    ensure_github_authenticated()?;
    if let Some(status) =
      fetch_pull_request_status(&workspace_path, &repo_slug_clone)?
    {
      return Ok(PullRequestInfo {
        number: status.number,
        url: status.url,
        base_branch: status.base_branch,
        head_branch: status.head_branch,
      });
    }
    push_branch(&workspace_path, &head_branch_clone)?;
    create_pull_request(
      &workspace_path,
      &repo_slug_clone,
      &head_branch_clone,
      &base_branch_clone,
    )?;
    let status = fetch_pull_request_status(&workspace_path, &repo_slug_clone)?
      .ok_or_else(|| "Pull request created but not found.".to_string())?;
    Ok(PullRequestInfo {
      number: status.number,
      url: status.url,
      base_branch: status.base_branch,
      head_branch: status.head_branch,
    })
  })
  .await
  .map_err(|err| err.to_string())?
  .map_err(|err| err.to_string())?;
  workspace::set_workspace_pr_info(
    db.pool(),
    &workspace_id,
    Some(info.number),
    Some(&info.url),
  )
  .await
  .map_err(|err| err.to_string())?;
  Ok(info)
}

#[allow(non_snake_case)]
#[tauri::command]
async fn mergePullRequest(
  db: tauri::State<'_, Database>,
  workspace_id: String,
) -> Result<(), String> {
  let workspace_record = workspace::get_workspace(db.pool(), &workspace_id)
    .await
    .map_err(|err| err.to_string())?;
  let repo = repos::get_repo_by_id(db.pool(), &workspace_record.repo_id)
    .await
    .map_err(|err| err.to_string())?;
  let repo_slug = repo
    .remote_url
    .as_deref()
    .and_then(parse_github_repo_slug)
    .ok_or_else(|| "Repository remote is not a GitHub URL.".to_string())?;
  let workspace_path = PathBuf::from(&workspace_record.path);
  let repo_slug_clone = repo_slug.clone();
  tauri::async_runtime::spawn_blocking(move || {
    ensure_github_authenticated()?;
    let status = fetch_pull_request_status(&workspace_path, &repo_slug_clone)?
      .ok_or_else(|| "No pull request found for this branch.".to_string())?;
    merge_pull_request(&workspace_path, &repo_slug_clone, status.number)
  })
  .await
  .map_err(|err| err.to_string())?
}

#[allow(non_snake_case)]
#[tauri::command]
async fn getPullRequestStatus(
  db: tauri::State<'_, Database>,
  workspace_id: String,
) -> Result<Option<PullRequestStatus>, String> {
  let workspace_record = workspace::get_workspace(db.pool(), &workspace_id)
    .await
    .map_err(|err| err.to_string())?;
  let repo = repos::get_repo_by_id(db.pool(), &workspace_record.repo_id)
    .await
    .map_err(|err| err.to_string())?;
  let repo_slug = repo
    .remote_url
    .as_deref()
    .and_then(parse_github_repo_slug)
    .ok_or_else(|| "Repository remote is not a GitHub URL.".to_string())?;
  let workspace_path = PathBuf::from(&workspace_record.path);
  let repo_slug_clone = repo_slug.clone();
  let status = tauri::async_runtime::spawn_blocking(move || {
    ensure_github_authenticated()?;
    fetch_pull_request_status(&workspace_path, &repo_slug_clone)
  })
  .await
  .map_err(|err| err.to_string())?
  .map_err(|err| err.to_string())?;
  if let Some(ref pr) = status {
    workspace::set_workspace_pr_info(
      db.pool(),
      &workspace_id,
      Some(pr.number),
      Some(&pr.url),
    )
    .await
    .map_err(|err| err.to_string())?;
  }
  Ok(status)
}

#[allow(non_snake_case)]
#[tauri::command]
async fn getPullRequestFailureLogs(
  db: tauri::State<'_, Database>,
  workspace_id: String,
) -> Result<String, String> {
  let workspace_record = workspace::get_workspace(db.pool(), &workspace_id)
    .await
    .map_err(|err| err.to_string())?;
  let repo = repos::get_repo_by_id(db.pool(), &workspace_record.repo_id)
    .await
    .map_err(|err| err.to_string())?;
  let repo_slug = repo
    .remote_url
    .as_deref()
    .and_then(parse_github_repo_slug)
    .ok_or_else(|| "Repository remote is not a GitHub URL.".to_string())?;
  let workspace_path = PathBuf::from(&workspace_record.path);
  let repo_slug_clone = repo_slug.clone();
  tauri::async_runtime::spawn_blocking(move || {
    ensure_github_authenticated()?;
    let status = fetch_pull_request_status(&workspace_path, &repo_slug_clone)?
      .ok_or_else(|| "No pull request found for this branch.".to_string())?;
    build_failure_logs(&workspace_path, &repo_slug_clone, &status.failing_checks)
  })
  .await
  .map_err(|err| err.to_string())?
  .map_err(|err| err.to_string())
}

#[allow(non_snake_case)]
#[tauri::command]
async fn fetchPullRequestComments(
  db: tauri::State<'_, Database>,
  workspace_id: String,
) -> Result<PullRequestCommentsResult, String> {
  let workspace_record = workspace::get_workspace(db.pool(), &workspace_id)
    .await
    .map_err(|err| err.to_string())?;
  let repo = repos::get_repo_by_id(db.pool(), &workspace_record.repo_id)
    .await
    .map_err(|err| err.to_string())?;
  let repo_slug = repo
    .remote_url
    .as_deref()
    .and_then(parse_github_repo_slug)
    .ok_or_else(|| "Repository remote is not a GitHub URL.".to_string())?;
  let workspace_path = PathBuf::from(&workspace_record.path);
  let repo_slug_clone = repo_slug.clone();
  let last_comment_id = workspace_record.pr_last_comment_id.clone();
  let pr_number = workspace_record.pr_number;
  let (result, latest_id) = tauri::async_runtime::spawn_blocking(move || {
    ensure_github_authenticated()?;
    let number = if let Some(existing) = pr_number {
      existing
    } else {
      let status = fetch_pull_request_status(&workspace_path, &repo_slug_clone)?
        .ok_or_else(|| "No pull request found for this branch.".to_string())?;
      status.number
    };
    fetch_pull_request_comments(
      &workspace_path,
      &repo_slug_clone,
      number,
      last_comment_id.as_deref(),
    )
  })
  .await
  .map_err(|err| err.to_string())?
  .map_err(|err| err.to_string())?;
  if let Some(latest) = latest_id {
    let latest_value = latest.to_string();
    if workspace_record.pr_last_comment_id.as_deref() != Some(latest_value.as_str()) {
      workspace::set_workspace_pr_last_comment_id(
        db.pool(),
        &workspace_id,
        Some(&latest_value),
      )
      .await
      .map_err(|err| err.to_string())?;
    }
  }
  if result.new_comments {
    workspace::set_workspace_unread(db.pool(), &workspace_id, true)
      .await
      .map_err(|err| err.to_string())?;
  }
  Ok(result)
}

fn spawn_run_output_reader(
  reader: impl Read + Send + 'static,
  window: tauri::Window,
  workspace_id: String,
  stream: &'static str,
) {
  std::thread::spawn(move || {
    let buffer = BufReader::new(reader);
    for line in buffer.lines() {
      match line {
        Ok(line) => {
          let payload = RunOutputEvent {
            workspace_id: workspace_id.clone(),
            stream: stream.to_string(),
            line,
          };
          let _ = window.emit("run-output", payload);
        }
        Err(err) => {
          eprintln!("[run-output] stream error: {err}");
          break;
        }
      }
    }
  });
}

#[allow(non_snake_case)]
#[tauri::command]
async fn startRunScript(
  window: tauri::Window,
  db: tauri::State<'_, Database>,
  paths: tauri::State<'_, AppPaths>,
  run_manager: tauri::State<'_, RunManager>,
  workspace_id: String,
) -> Result<(), String> {
  let workspace_record = workspace::get_workspace(db.pool(), &workspace_id)
    .await
    .map_err(|err| err.to_string())?;
  let repo = repos::get_repo_by_id(db.pool(), &workspace_record.repo_id)
    .await
    .map_err(|err| err.to_string())?;
  let script = repo
    .scripts_run
    .as_ref()
    .filter(|value| !value.trim().is_empty())
    .ok_or_else(|| "Run script is not configured for this repository.".to_string())?;
  let env_vars_raw = settings::get_env_vars(db.pool())
    .await
    .map_err(|err| err.to_string())?;
  let root = resolve_workspace_root(&paths, Path::new(&workspace_record.path))?;
  let envs = build_workspace_env(
    &repo,
    &workspace_id,
    workspace_record.directory_name.as_deref(),
    &root,
    workspace_record.base_port,
    &env_vars_raw,
  );
  let target_repo_id = repo.id.clone();
  if repo.run_script_mode.as_deref() == Some("nonconcurrent") {
    let pids = {
      let guard = run_manager
        .processes
        .lock()
        .map_err(|_| "Run manager lock poisoned".to_string())?;
      guard
        .values()
        .filter(|process| process.repo_id == target_repo_id)
        .map(|process| process.pid)
        .collect::<Vec<_>>()
    };
    for pid in pids {
      terminate_process_tree(pid)?;
    }
  }

  let mut command = build_shell_command(script);
  command.current_dir(&root);
  apply_env_to_command(&mut command, &envs);
  command.stdout(Stdio::piped());
  command.stderr(Stdio::piped());
  configure_process_group(&mut command);
  let mut child = command.spawn().map_err(|err| err.to_string())?;
  let pid = child.id();
  {
    let mut guard = run_manager
      .processes
      .lock()
      .map_err(|_| "Run manager lock poisoned".to_string())?;
    guard.insert(
      workspace_id.clone(),
      RunProcess {
        pid,
        repo_id: repo.id.clone(),
      },
    );
  }
  if let Some(stdout) = child.stdout.take() {
    spawn_run_output_reader(stdout, window.clone(), workspace_id.clone(), "stdout");
  }
  if let Some(stderr) = child.stderr.take() {
    spawn_run_output_reader(stderr, window.clone(), workspace_id.clone(), "stderr");
  }

  let run_manager = run_manager.inner().clone();
  let window = window.clone();
  let workspace_id_clone = workspace_id.clone();
  std::thread::spawn(move || {
    let status = child.wait().ok();
    if let Ok(mut guard) = run_manager.processes.lock() {
      guard.remove(&workspace_id_clone);
    }
    let _ = window.emit(
      "run-exit",
      RunExitEvent {
        workspace_id: workspace_id_clone,
        code: status.and_then(|value| value.code()),
      },
    );
  });

  Ok(())
}

#[allow(non_snake_case)]
#[tauri::command]
async fn stopRunScript(
  run_manager: tauri::State<'_, RunManager>,
  workspace_id: String,
) -> Result<(), String> {
  let pid = {
    let guard = run_manager
      .processes
      .lock()
      .map_err(|_| "Run manager lock poisoned".to_string())?;
    guard.get(&workspace_id).map(|process| process.pid)
  };
  if let Some(pid) = pid {
    terminate_process_tree(pid)?;
  }
  Ok(())
}

#[allow(non_snake_case)]
#[tauri::command]
async fn createTerminal(
  window: tauri::Window,
  db: tauri::State<'_, Database>,
  paths: tauri::State<'_, AppPaths>,
  terminal_manager: tauri::State<'_, TerminalManager>,
  workspace_id: String,
  cols: u16,
  rows: u16,
) -> Result<String, String> {
  let workspace_record = workspace::get_workspace(db.pool(), &workspace_id)
    .await
    .map_err(|err| err.to_string())?;
  let repo = repos::get_repo_by_id(db.pool(), &workspace_record.repo_id)
    .await
    .map_err(|err| err.to_string())?;
  let env_vars_raw = settings::get_env_vars(db.pool())
    .await
    .map_err(|err| err.to_string())?;
  let root = resolve_workspace_root(&paths, Path::new(&workspace_record.path))?;
  let envs = build_workspace_env(
    &repo,
    &workspace_id,
    workspace_record.directory_name.as_deref(),
    &root,
    workspace_record.base_port,
    &env_vars_raw,
  );

  let (shell, args) = default_shell_command();
  let pty_system = native_pty_system();
  let size = PtySize {
    rows: rows.max(1),
    cols: cols.max(1),
    pixel_width: 0,
    pixel_height: 0,
  };
  let pair = pty_system
    .openpty(size)
    .map_err(|err| err.to_string())?;
  let mut command = CommandBuilder::new(shell);
  command.args(args);
  command.cwd(root);
  apply_env_to_builder(&mut command, &envs);
  command.env("TERM", "xterm-256color");
  let child = pair
    .slave
    .spawn_command(command)
    .map_err(|err| err.to_string())?;
  drop(pair.slave);
  let mut reader = pair
    .master
    .try_clone_reader()
    .map_err(|err| err.to_string())?;
  let writer = pair.master.take_writer().map_err(|err| err.to_string())?;
  let terminal_id = next_terminal_id();
  let session = TerminalSession {
    master: Arc::new(Mutex::new(pair.master)),
    writer: Arc::new(Mutex::new(writer)),
    child: Arc::new(Mutex::new(child)),
  };
  {
    let mut guard = terminal_manager
      .sessions
      .lock()
      .map_err(|_| "Terminal manager lock poisoned".to_string())?;
    guard.insert(terminal_id.clone(), session);
  }

  let window_reader = window.clone();
  let terminal_id_reader = terminal_id.clone();
  std::thread::spawn(move || {
    let mut buffer = [0u8; 4096];
    loop {
      match reader.read(&mut buffer) {
        Ok(0) => break,
        Ok(count) => {
          let data = String::from_utf8_lossy(&buffer[..count]).to_string();
          let _ = window_reader.emit(
            "terminal-output",
            TerminalOutputEvent {
              terminal_id: terminal_id_reader.clone(),
              data,
            },
          );
        }
        Err(err) => {
          eprintln!("[terminal-output] read error: {err}");
          break;
        }
      }
    }
  });

  let terminal_manager = terminal_manager.inner().clone();
  let window_exit = window.clone();
  let terminal_id_exit = terminal_id.clone();
  let child_handle = {
    let guard = terminal_manager
      .sessions
      .lock()
      .map_err(|_| "Terminal manager lock poisoned".to_string())?;
    guard
      .get(&terminal_id_exit)
      .map(|session| session.child.clone())
      .ok_or_else(|| "Terminal session not found".to_string())?
  };
  std::thread::spawn(move || {
    let _ = match child_handle.lock() {
      Ok(mut guard) => guard.wait().ok(),
      Err(err) => {
        eprintln!("[terminal-exit] child lock poisoned: {err}");
        None
      }
    };
    if let Ok(mut guard) = terminal_manager.sessions.lock() {
      guard.remove(&terminal_id_exit);
    }
    let _ = window_exit.emit(
      "terminal-exit",
      TerminalExitEvent {
        terminal_id: terminal_id_exit,
      },
    );
  });

  Ok(terminal_id)
}

#[allow(non_snake_case)]
#[tauri::command]
async fn writeTerminal(
  terminal_manager: tauri::State<'_, TerminalManager>,
  terminal_id: String,
  data: String,
) -> Result<(), String> {
  let writer = {
    let guard = terminal_manager
      .sessions
      .lock()
      .map_err(|_| "Terminal manager lock poisoned".to_string())?;
    guard
      .get(&terminal_id)
      .map(|session| session.writer.clone())
      .ok_or_else(|| "Terminal session not found".to_string())?
  };
  let mut guard = writer
    .lock()
    .map_err(|_| "Terminal writer lock poisoned".to_string())?;
  guard
    .write_all(data.as_bytes())
    .map_err(|err| err.to_string())
}

#[allow(non_snake_case)]
#[tauri::command]
async fn resizeTerminal(
  terminal_manager: tauri::State<'_, TerminalManager>,
  terminal_id: String,
  cols: u16,
  rows: u16,
) -> Result<(), String> {
  let master = {
    let guard = terminal_manager
      .sessions
      .lock()
      .map_err(|_| "Terminal manager lock poisoned".to_string())?;
    guard
      .get(&terminal_id)
      .map(|session| session.master.clone())
      .ok_or_else(|| "Terminal session not found".to_string())?
  };
  let guard = master
    .lock()
    .map_err(|_| "Terminal master lock poisoned".to_string())?;
  guard
    .resize(PtySize {
      rows: rows.max(1),
      cols: cols.max(1),
      pixel_width: 0,
      pixel_height: 0,
    })
    .map_err(|err| err.to_string())
}

#[allow(non_snake_case)]
#[tauri::command]
async fn closeTerminal(
  terminal_manager: tauri::State<'_, TerminalManager>,
  terminal_id: String,
) -> Result<(), String> {
  let session = {
    let mut guard = terminal_manager
      .sessions
      .lock()
      .map_err(|_| "Terminal manager lock poisoned".to_string())?;
    guard.remove(&terminal_id)
  };
  if let Some(session) = session {
    let mut child_guard = session
      .child
      .lock()
      .map_err(|_| "Terminal child lock poisoned".to_string())?;
    let _ = child_guard.kill();
    let _ = child_guard.wait();
  }
  Ok(())
}

#[allow(non_snake_case)]
#[tauri::command]
fn openPathIn(path: String, target: OpenTarget) -> Result<(), String> {
  let path = PathBuf::from(path);
  if !path.exists() {
    return Err(format!("Path does not exist: {}", path.display()));
  }

  let mut command = build_open_command(&path, &target);

  command
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .spawn()
    .map_err(|err| err.to_string())?;
  Ok(())
}

fn build_open_command(path: &PathBuf, target: &OpenTarget) -> Command {
  #[cfg(target_os = "windows")]
  {
    let program = match target {
      OpenTarget::System => "explorer",
      OpenTarget::Vscode => "code",
      OpenTarget::Cursor => "cursor",
      OpenTarget::Zed => "zed",
    };
    let mut command = Command::new(program);
    command.arg(path);
    return command;
  }

  #[cfg(target_os = "macos")]
  {
    let mut command = Command::new("open");
    match target {
      OpenTarget::System => {
        command.arg(path);
      }
      OpenTarget::Vscode => {
        command.arg("-a").arg("Visual Studio Code").arg(path);
      }
      OpenTarget::Cursor => {
        command.arg("-a").arg("Cursor").arg(path);
      }
      OpenTarget::Zed => {
        command.arg("-a").arg("Zed").arg(path);
      }
    }
    return command;
  }

  #[cfg(target_os = "linux")]
  {
    let program = match target {
      OpenTarget::System => "xdg-open",
      OpenTarget::Vscode => "code",
      OpenTarget::Cursor => "cursor",
      OpenTarget::Zed => "zed",
    };
    let mut command = Command::new(program);
    command.arg(path);
    return command;
  }

  #[allow(unreachable_code)]
  Command::new("true")
}

fn ensure_context_dirs(workspace_path: &Path) -> Result<(), String> {
  let context_dir = workspace_path.join(".context").join("attachments");
  fs::create_dir_all(&context_dir).map_err(|err| err.to_string())
}

fn validate_todos(items: &[ManualTodoItem]) -> Result<(), String> {
  let mut ids = HashSet::new();
  for item in items {
    let trimmed_id = item.id.trim();
    if trimmed_id.is_empty() {
      return Err("Todo id is required.".to_string());
    }
    if item.text.trim().is_empty() {
      return Err("Todo text is required.".to_string());
    }
    if !ids.insert(trimmed_id.to_string()) {
      return Err(format!("Duplicate todo id: {}", trimmed_id));
    }
  }
  Ok(())
}

fn sanitize_filename(value: &str) -> String {
  let base = Path::new(value)
    .file_name()
    .and_then(|name| name.to_str())
    .unwrap_or("attachment");
  let mut sanitized = String::with_capacity(base.len());
  for ch in base.chars() {
    if ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_' {
      sanitized.push(ch);
    } else {
      sanitized.push('_');
    }
  }
  if sanitized.is_empty() {
    "attachment".to_string()
  } else {
    sanitized
  }
}

fn configure_gh_command(command: &mut Command) {
  command.env("GH_PAGER", "cat");
  command.env("GH_NO_UPDATE_NOTIFIER", "1");
  command.env("GH_PROMPT_DISABLED", "1");
}

fn run_command(command: &mut Command, label: &str) -> Result<std::process::Output, String> {
  command.output().map_err(|err| format!("{label} failed: {err}"))
}

fn run_command_output(command: &mut Command, label: &str) -> Result<String, String> {
  let output = run_command(command, label)?;
  let stdout = String::from_utf8_lossy(&output.stdout);
  let stderr = String::from_utf8_lossy(&output.stderr);
  if !output.status.success() {
    let message = if !stderr.trim().is_empty() {
      stderr.trim().to_string()
    } else if !stdout.trim().is_empty() {
      stdout.trim().to_string()
    } else {
      format!("exit code {:?}", output.status.code())
    };
    return Err(format!("{label} failed: {message}"));
  }
  Ok(stdout.trim().to_string())
}

fn detect_github_auth_status() -> GithubAuthStatus {
  let mut command = Command::new("gh");
  command.args(["auth", "status", "--hostname", "github.com"]);
  configure_gh_command(&mut command);
  match command.output() {
    Err(err) if err.kind() == std::io::ErrorKind::NotFound => GithubAuthStatus {
      available: false,
      authenticated: false,
      message: Some("GitHub CLI (gh) is not installed.".to_string()),
    },
    Err(err) => GithubAuthStatus {
      available: false,
      authenticated: false,
      message: Some(format!("Failed to run GitHub CLI: {err}")),
    },
    Ok(output) => {
      let stdout = String::from_utf8_lossy(&output.stdout);
      let stderr = String::from_utf8_lossy(&output.stderr);
      let message = if !stderr.trim().is_empty() {
        Some(stderr.trim().to_string())
      } else if !stdout.trim().is_empty() {
        Some(stdout.trim().to_string())
      } else {
        None
      };
      GithubAuthStatus {
        available: true,
        authenticated: output.status.success(),
        message,
      }
    }
  }
}

fn ensure_github_authenticated() -> Result<(), String> {
  let status = detect_github_auth_status();
  if !status.available {
    return Err(status
      .message
      .unwrap_or_else(|| "GitHub CLI (gh) is not available.".to_string()));
  }
  if !status.authenticated {
    return Err(status.message.unwrap_or_else(|| {
      "GitHub CLI is not authenticated. Run `gh auth login`.".to_string()
    }));
  }
  Ok(())
}

fn parse_github_repo_slug(remote_url: &str) -> Option<String> {
  let trimmed = remote_url.trim();
  let index = trimmed.find("github.com")?;
  let mut remainder = &trimmed[index + "github.com".len()..];
  remainder = remainder.trim_start_matches([':', '/']);
  remainder = remainder.trim_end_matches(".git");
  remainder = remainder.trim_end_matches('/');
  let mut parts = remainder.split('/');
  let owner = parts.next()?.trim();
  let repo = parts.next()?.trim();
  if owner.is_empty() || repo.is_empty() {
    return None;
  }
  Some(format!("{owner}/{repo}"))
}

fn push_branch(workspace_path: &Path, branch: &str) -> Result<(), String> {
  let mut command = Command::new("git");
  command
    .arg("-C")
    .arg(workspace_path)
    .arg("push")
    .arg("-u")
    .arg("origin")
    .arg(branch)
    .env("GIT_TERMINAL_PROMPT", "0");
  run_command_output(&mut command, "git push")?;
  Ok(())
}

fn create_pull_request(
  workspace_path: &Path,
  repo_slug: &str,
  head_branch: &str,
  base_branch: &str,
) -> Result<(), String> {
  let mut command = Command::new("gh");
  command.current_dir(workspace_path);
  command.args([
    "pr",
    "create",
    "--repo",
    repo_slug,
    "--head",
    head_branch,
    "--base",
    base_branch,
    "--title",
    head_branch,
    "--body",
    "Created by Supertree.",
  ]);
  configure_gh_command(&mut command);
  run_command_output(&mut command, "gh pr create")?;
  Ok(())
}

fn merge_pull_request(
  workspace_path: &Path,
  repo_slug: &str,
  pr_number: i64,
) -> Result<(), String> {
  let pr_number_str = pr_number.to_string();
  let mut command = Command::new("gh");
  command.current_dir(workspace_path);
  command.args([
    "pr",
    "merge",
    pr_number_str.as_str(),
    "--merge",
    "--delete-branch",
    "--yes",
    "--repo",
    repo_slug,
  ]);
  configure_gh_command(&mut command);
  run_command_output(&mut command, "gh pr merge")?;
  Ok(())
}

fn fetch_pull_request_status(
  workspace_path: &Path,
  repo_slug: &str,
) -> Result<Option<PullRequestStatus>, String> {
  let mut command = Command::new("gh");
  command.current_dir(workspace_path);
  command.args([
    "pr",
    "view",
    "--json",
    "number,url,baseRefName,headRefName,reviewDecision,mergeable,state,statusCheckRollup",
    "--repo",
    repo_slug,
  ]);
  configure_gh_command(&mut command);
  let output = run_command(&mut command, "gh pr view")?;
  let stdout = String::from_utf8_lossy(&output.stdout);
  let stderr = String::from_utf8_lossy(&output.stderr);
  if !output.status.success() {
    let combined = format!("{stdout}\n{stderr}");
    let normalized = combined.to_lowercase();
    if normalized.contains("no pull request") || normalized.contains("no pull requests") {
      return Ok(None);
    }
    let message = if !stderr.trim().is_empty() {
      stderr.trim().to_string()
    } else {
      stdout.trim().to_string()
    };
    return Err(format!("gh pr view failed: {message}"));
  }
  let parsed: Value =
    serde_json::from_str(&stdout).map_err(|err| format!("Failed to parse PR data: {err}"))?;
  let status = parse_pull_request_status(&parsed)?;
  Ok(Some(status))
}

fn parse_pull_request_status(value: &Value) -> Result<PullRequestStatus, String> {
  let number = value
    .get("number")
    .and_then(|val| val.as_i64())
    .ok_or_else(|| "PR number missing from GitHub response.".to_string())?;
  let url = value
    .get("url")
    .and_then(|val| val.as_str())
    .ok_or_else(|| "PR url missing from GitHub response.".to_string())?
    .to_string();
  let base_branch = value
    .get("baseRefName")
    .and_then(|val| val.as_str())
    .unwrap_or("main")
    .to_string();
  let head_branch = value
    .get("headRefName")
    .and_then(|val| val.as_str())
    .unwrap_or("head")
    .to_string();
  let review_decision = value
    .get("reviewDecision")
    .and_then(|val| val.as_str())
    .map(|val| val.to_string());
  let mergeable = value
    .get("mergeable")
    .and_then(|val| val.as_str())
    .map(|val| val.to_string());
  let state = value
    .get("state")
    .and_then(|val| val.as_str())
    .map(|val| val.to_string());
  let mut summary = PullRequestCheckSummary {
    total: 0,
    failed: 0,
    pending: 0,
    success: 0,
  };
  let mut failing_checks = Vec::new();
  if let Some(checks) = value.get("statusCheckRollup").and_then(|val| val.as_array()) {
    for check in checks {
      let name = check
        .get("name")
        .or_else(|| check.get("context"))
        .and_then(|val| val.as_str())
        .unwrap_or("Check")
        .to_string();
      let status = check.get("status").and_then(|val| val.as_str()).map(|val| val.to_string());
      let conclusion =
        check.get("conclusion").and_then(|val| val.as_str()).map(|val| val.to_string());
      let state_value = check.get("state").and_then(|val| val.as_str()).map(|val| val.to_string());
      let normalized_status = status.clone().or_else(|| state_value.clone());
      let normalized_conclusion = conclusion.clone().or_else(|| state_value.clone());
      let details_url = check
        .get("detailsUrl")
        .or_else(|| check.get("targetUrl"))
        .or_else(|| check.get("url"))
        .and_then(|val| val.as_str())
        .map(|val| val.to_string());
      let check_entry = PullRequestCheck {
        name,
        status: normalized_status.clone(),
        conclusion: normalized_conclusion.clone(),
        details_url,
      };
      summary.total += 1;
      match classify_check(
        normalized_status.as_deref(),
        normalized_conclusion.as_deref(),
      ) {
        CheckOutcome::Success => summary.success += 1,
        CheckOutcome::Pending => summary.pending += 1,
        CheckOutcome::Failed => {
          summary.failed += 1;
          failing_checks.push(check_entry.clone());
        }
      }
    }
  }
  Ok(PullRequestStatus {
    number,
    url,
    base_branch,
    head_branch,
    review_decision,
    mergeable,
    state,
    checks: summary,
    failing_checks,
  })
}

enum CheckOutcome {
  Success,
  Pending,
  Failed,
}

fn classify_check(status: Option<&str>, conclusion: Option<&str>) -> CheckOutcome {
  let normalized_status = status.unwrap_or("").trim().to_uppercase();
  let normalized_conclusion = conclusion.unwrap_or("").trim().to_uppercase();
  if !normalized_conclusion.is_empty() {
    return match normalized_conclusion.as_str() {
      "SUCCESS" | "NEUTRAL" | "SKIPPED" => CheckOutcome::Success,
      "PENDING" | "IN_PROGRESS" | "QUEUED" => CheckOutcome::Pending,
      _ => CheckOutcome::Failed,
    };
  }
  if !normalized_status.is_empty() {
    return match normalized_status.as_str() {
      "IN_PROGRESS" | "QUEUED" | "PENDING" | "REQUESTED" => CheckOutcome::Pending,
      "SUCCESS" | "COMPLETED" => CheckOutcome::Success,
      "FAILURE" | "ERROR" | "CANCELLED" | "TIMED_OUT" => CheckOutcome::Failed,
      _ => CheckOutcome::Pending,
    };
  }
  CheckOutcome::Pending
}

fn extract_run_id(details_url: &str) -> Option<String> {
  let marker = "/actions/runs/";
  let index = details_url.find(marker)?;
  let remainder = &details_url[index + marker.len()..];
  let id: String = remainder.chars().take_while(|ch| ch.is_ascii_digit()).collect();
  if id.is_empty() {
    None
  } else {
    Some(id)
  }
}

fn fetch_run_logs(workspace_path: &Path, repo_slug: &str, run_id: &str) -> Result<String, String> {
  let mut command = Command::new("gh");
  command.current_dir(workspace_path);
  command.args(["run", "view", run_id, "--log", "--repo", repo_slug]);
  configure_gh_command(&mut command);
  run_command_output(&mut command, "gh run view")
}

fn build_failure_logs(
  workspace_path: &Path,
  repo_slug: &str,
  checks: &[PullRequestCheck],
) -> Result<String, String> {
  if checks.is_empty() {
    return Err("No failing checks found for this pull request.".to_string());
  }
  let mut output = String::new();
  let mut seen_runs = HashSet::new();
  for check in checks {
    output.push_str(&format!("## {}\n", check.name));
    if let Some(status) = check.status.as_deref() {
      output.push_str(&format!("Status: {status}\n"));
    }
    if let Some(conclusion) = check.conclusion.as_deref() {
      output.push_str(&format!("Conclusion: {conclusion}\n"));
    }
    if let Some(details) = check.details_url.as_deref() {
      output.push_str(&format!("Details: {details}\n"));
      if let Some(run_id) = extract_run_id(details) {
        if seen_runs.insert(run_id.clone()) {
          output.push('\n');
          match fetch_run_logs(workspace_path, repo_slug, &run_id) {
            Ok(logs) => {
              output.push_str(&logs);
              if !logs.ends_with('\n') {
                output.push('\n');
              }
            }
            Err(err) => {
              output.push_str(&format!("Failed to fetch logs for run {run_id}: {err}\n"));
            }
          }
        } else {
          output.push_str(&format!("Logs already captured for run {run_id}.\n"));
        }
      } else {
        output.push_str("Unable to extract a GitHub Actions run id from the details URL.\n");
      }
    } else {
      output.push_str("No details URL available for this check.\n");
    }
    output.push('\n');
  }
  Ok(output)
}

fn run_gh_api(
  workspace_path: &Path,
  repo_slug: &str,
  endpoint: &str,
) -> Result<Vec<Value>, String> {
  let mut command = Command::new("gh");
  command.current_dir(workspace_path);
  command.args([
    "api",
    "-H",
    "Accept: application/vnd.github+json",
    &format!("repos/{repo_slug}/{endpoint}"),
  ]);
  configure_gh_command(&mut command);
  let output = run_command_output(&mut command, "gh api")?;
  serde_json::from_str::<Vec<Value>>(&output)
    .map_err(|err| format!("Failed to parse GitHub response: {err}"))
}

fn fetch_pull_request_comments(
  workspace_path: &Path,
  repo_slug: &str,
  pr_number: i64,
  last_comment_id: Option<&str>,
) -> Result<(PullRequestCommentsResult, Option<i64>), String> {
  let reviews = run_gh_api(workspace_path, repo_slug, &format!("pulls/{pr_number}/reviews"))?;
  let review_comments =
    run_gh_api(workspace_path, repo_slug, &format!("pulls/{pr_number}/comments"))?;
  let issue_comments =
    run_gh_api(workspace_path, repo_slug, &format!("issues/{pr_number}/comments"))?;
  let (content, latest_id) = format_pr_comments(&reviews, &review_comments, &issue_comments);
  let last_seen = last_comment_id.and_then(|value| value.parse::<i64>().ok());
  let new_comments = latest_id
    .map(|value| last_seen.map(|last| value > last).unwrap_or(true))
    .unwrap_or(false);
  Ok((PullRequestCommentsResult { content, new_comments }, latest_id))
}

fn format_pr_comments(
  reviews: &[Value],
  review_comments: &[Value],
  issue_comments: &[Value],
) -> (String, Option<i64>) {
  let mut latest_id: Option<i64> = None;
  let mut output = String::new();
  let mut has_any = false;

  let mut track_id = |id: Option<i64>| {
    if let Some(value) = id {
      latest_id = Some(latest_id.map_or(value, |current| current.max(value)));
    }
  };

  if !reviews.is_empty() {
    has_any = true;
    output.push_str("## Reviews\n");
    for review in reviews {
      track_id(review.get("id").and_then(|val| val.as_i64()));
      let state = review
        .get("state")
        .and_then(|val| val.as_str())
        .unwrap_or("UNKNOWN");
      let user = review
        .get("user")
        .and_then(|val| val.get("login"))
        .and_then(|val| val.as_str())
        .unwrap_or("unknown");
      let submitted_at = review
        .get("submitted_at")
        .and_then(|val| val.as_str())
        .unwrap_or("unknown date");
      output.push_str(&format!("- {state} by {user} ({submitted_at})\n"));
      if let Some(body) = review.get("body").and_then(|val| val.as_str()) {
        let trimmed = body.trim();
        if !trimmed.is_empty() {
          output.push_str(&format!("  {trimmed}\n"));
        }
      }
    }
    output.push('\n');
  }

  if !review_comments.is_empty() {
    has_any = true;
    output.push_str("## Inline comments\n");
    for comment in review_comments {
      track_id(comment.get("id").and_then(|val| val.as_i64()));
      let path = comment.get("path").and_then(|val| val.as_str()).unwrap_or("file");
      let line = comment
        .get("line")
        .or_else(|| comment.get("position"))
        .or_else(|| comment.get("original_line"))
        .and_then(|val| val.as_i64())
        .map(|val| val.to_string())
        .unwrap_or_else(|| "unknown".to_string());
      let user = comment
        .get("user")
        .and_then(|val| val.get("login"))
        .and_then(|val| val.as_str())
        .unwrap_or("unknown");
      let created_at = comment
        .get("created_at")
        .and_then(|val| val.as_str())
        .unwrap_or("unknown date");
      output.push_str(&format!("- {path}:{line} by {user} ({created_at})\n"));
      if let Some(body) = comment.get("body").and_then(|val| val.as_str()) {
        let trimmed = body.trim();
        if !trimmed.is_empty() {
          output.push_str(&format!("  {trimmed}\n"));
        }
      }
    }
    output.push('\n');
  }

  if !issue_comments.is_empty() {
    has_any = true;
    output.push_str("## Issue comments\n");
    for comment in issue_comments {
      track_id(comment.get("id").and_then(|val| val.as_i64()));
      let user = comment
        .get("user")
        .and_then(|val| val.get("login"))
        .and_then(|val| val.as_str())
        .unwrap_or("unknown");
      let created_at = comment
        .get("created_at")
        .and_then(|val| val.as_str())
        .unwrap_or("unknown date");
      output.push_str(&format!("- {user} ({created_at})\n"));
      if let Some(body) = comment.get("body").and_then(|val| val.as_str()) {
        let trimmed = body.trim();
        if !trimmed.is_empty() {
          output.push_str(&format!("  {trimmed}\n"));
        }
      }
    }
    output.push('\n');
  }

  if !has_any {
    output.clear();
  }

  (output, latest_id)
}

const MAX_WORKSPACE_FILES: usize = 2000;
const MAX_FILE_PREVIEW_BYTES: usize = 200_000;

fn resolve_workspace_root(paths: &AppPaths, workspace_path: &Path) -> Result<PathBuf, String> {
  let workspace_root = paths
    .workspaces_dir
    .canonicalize()
    .map_err(|err| format!("Cannot resolve workspaces root: {err}"))?;
  let resolved = workspace_path
    .canonicalize()
    .map_err(|err| format!("Cannot resolve workspace path: {err}"))?;
  if !resolved.starts_with(&workspace_root) {
    return Err(format!(
      "Refusing to access workspace outside managed directory: {}",
      resolved.display()
    ));
  }
  Ok(resolved)
}

fn should_skip_dir(path: &Path) -> bool {
  let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
    return true;
  };
  matches!(
    name,
    ".git"
      | "node_modules"
      | "target"
      | "dist"
      | "build"
      | "out"
      | ".turbo"
      | ".next"
      | ".cache"
  )
}

fn is_likely_binary(buffer: &[u8]) -> bool {
  buffer.iter().take(8_000).any(|&byte| byte == 0)
}

fn list_workspace_files(root: &Path) -> Result<Vec<String>, String> {
  let mut results = Vec::new();
  let mut stack = vec![root.to_path_buf()];
  let mut limit_reached = false;
  while let Some(dir) = stack.pop() {
    let entries = fs::read_dir(&dir).map_err(|err| err.to_string())?;
    for entry in entries {
      let entry = entry.map_err(|err| err.to_string())?;
      let path = entry.path();
      let file_type = entry.file_type().map_err(|err| err.to_string())?;
      if file_type.is_dir() {
        if should_skip_dir(&path) {
          continue;
        }
        stack.push(path);
        continue;
      }
      if !file_type.is_file() {
        continue;
      }
      let relative = path
        .strip_prefix(root)
        .map_err(|err| err.to_string())?
        .to_string_lossy()
        .replace('\\', "/");
      results.push(relative);
      if results.len() >= MAX_WORKSPACE_FILES {
        limit_reached = true;
        break;
      }
    }
    if limit_reached {
      break;
    }
  }
  results.sort();
  if results.len() > MAX_WORKSPACE_FILES {
    results.truncate(MAX_WORKSPACE_FILES);
  }
  Ok(results)
}

fn read_workspace_file(root: &Path, relative_path: &str) -> Result<FilePreview, String> {
  let candidate = PathBuf::from(relative_path);
  if candidate.is_absolute() {
    return Err("Path must be workspace-relative".to_string());
  }
  let file_path = root.join(candidate);
  let resolved = file_path
    .canonicalize()
    .map_err(|err| format!("Cannot resolve file path: {err}"))?;
  if !resolved.starts_with(root) {
    return Err(format!(
      "Refusing to read file outside workspace: {}",
      resolved.display()
    ));
  }
  if !resolved.is_file() {
    return Err(format!("File not found: {}", resolved.display()));
  }
  let file = fs::File::open(&resolved).map_err(|err| err.to_string())?;
  let mut buffer = Vec::new();
  let mut handle = file.take((MAX_FILE_PREVIEW_BYTES + 1) as u64);
  handle.read_to_end(&mut buffer).map_err(|err| err.to_string())?;
  let truncated = buffer.len() > MAX_FILE_PREVIEW_BYTES;
  if truncated {
    buffer.truncate(MAX_FILE_PREVIEW_BYTES);
  }
  let binary = is_likely_binary(&buffer);
  let content = if binary {
    String::new()
  } else {
    String::from_utf8_lossy(&buffer).to_string()
  };
  let relative = resolved
    .strip_prefix(root)
    .map_err(|err| err.to_string())?
    .to_string_lossy()
    .replace('\\', "/");
  Ok(FilePreview {
    path: relative,
    content,
    truncated: truncated && !binary,
    binary,
  })
}

static TERMINAL_COUNTER: AtomicUsize = AtomicUsize::new(1);

fn next_terminal_id() -> String {
  let next = TERMINAL_COUNTER.fetch_add(1, Ordering::SeqCst);
  format!("terminal-{next}")
}

fn timestamp_millis() -> u128 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_default()
    .as_millis()
}

fn parse_env_vars(raw: &str) -> Vec<(String, String)> {
  raw.lines()
    .filter_map(|line| {
      let trimmed = line.trim();
      if trimmed.is_empty() {
        return None;
      }
      let without_export = trimmed.strip_prefix("export ").unwrap_or(trimmed);
      let (key, value) = without_export.split_once('=')?;
      let key = key.trim();
      if key.is_empty() {
        return None;
      }
      let value = value.trim();
      let value = if value.len() >= 2
        && ((value.starts_with('"') && value.ends_with('"'))
          || (value.starts_with('\'') && value.ends_with('\'')))
      {
        &value[1..value.len() - 1]
      } else {
        value
      };
      Some((key.to_string(), value.to_string()))
    })
    .collect()
}

fn build_workspace_env(
  repo: &RepoRecord,
  workspace_id: &str,
  workspace_name: Option<&str>,
  workspace_path: &Path,
  base_port: Option<i64>,
  env_vars_raw: &str,
) -> Vec<(String, String)> {
  let mut envs = vec![
    (
      "supertree_WORKSPACE_NAME".to_string(),
      workspace_name.unwrap_or(workspace_id).to_string(),
    ),
    (
      "supertree_WORKSPACE_PATH".to_string(),
      workspace_path.to_string_lossy().to_string(),
    ),
    ("supertree_ROOT_PATH".to_string(), repo.root_path.clone()),
    (
      "supertree_DEFAULT_BRANCH".to_string(),
      repo.default_branch.clone(),
    ),
  ];
  if let Some(port) = base_port {
    envs.push(("supertree_PORT".to_string(), port.to_string()));
  }
  envs.extend(parse_env_vars(env_vars_raw));
  envs
}

fn apply_env_to_command(command: &mut Command, envs: &[(String, String)]) {
  for (key, value) in envs {
    command.env(key, value);
  }
}

fn apply_env_to_builder(builder: &mut CommandBuilder, envs: &[(String, String)]) {
  for (key, value) in envs {
    builder.env(key, value);
  }
}

fn build_log_path(paths: &AppPaths, kind: &str, workspace_id: &str) -> PathBuf {
  let stamp = timestamp_millis();
  paths
    .logs_dir
    .join(format!("{kind}-{workspace_id}-{stamp}.log"))
}

fn run_workspace_script_with_log(
  script: &str,
  workspace_path: &Path,
  envs: &[(String, String)],
  log_path: &Path,
) -> Result<(), String> {
  let log_file = fs::File::create(log_path).map_err(|err| err.to_string())?;
  let log_err = log_file.try_clone().map_err(|err| err.to_string())?;
  let mut command = build_shell_command(script);
  command.current_dir(workspace_path);
  apply_env_to_command(&mut command, envs);
  command.stdout(Stdio::from(log_file));
  command.stderr(Stdio::from(log_err));
  configure_process_group(&mut command);
  let status = command.status().map_err(|err| err.to_string())?;
  if !status.success() {
    return Err(format!(
      "Workspace script failed ({}). See log: {}",
      script,
      log_path.display()
    ));
  }
  Ok(())
}

fn default_shell_command() -> (String, Vec<String>) {
  #[cfg(target_os = "windows")]
  {
    return ("powershell.exe".to_string(), vec!["-NoLogo".to_string()]);
  }

  #[cfg(target_os = "macos")]
  {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "zsh".to_string());
    return (shell, vec!["-l".to_string()]);
  }

  #[cfg(all(unix, not(target_os = "macos")))]
  {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "bash".to_string());
    return (shell, vec!["-l".to_string()]);
  }
}

fn configure_process_group(command: &mut Command) {
  #[cfg(unix)]
  {
    unsafe {
      let _ = command.pre_exec(|| {
        unsafe {
          if libc::setpgid(0, 0) != 0 {
            return Err(std::io::Error::last_os_error());
          }
        }
        Ok(())
      });
    }
  }
  #[cfg(not(unix))]
  {
    let _ = command;
  }
}

fn terminate_process_tree(pid: u32) -> Result<(), String> {
  #[cfg(target_os = "windows")]
  {
    let status = Command::new("taskkill")
      .arg("/PID")
      .arg(pid.to_string())
      .arg("/T")
      .arg("/F")
      .status()
      .map_err(|err| err.to_string())?;
    if !status.success() {
      return Ok(());
    }
  }

  #[cfg(unix)]
  unsafe {
    let pgid = -(pid as i32);
    if libc::kill(pgid, libc::SIGTERM) != 0 {
      let err = std::io::Error::last_os_error();
      if err.raw_os_error() != Some(libc::ESRCH) {
        return Err(format!("Failed to terminate process group for pid {pid}: {err}"));
      }
    } else {
      std::thread::sleep(Duration::from_millis(100));
      if libc::kill(pgid, libc::SIGKILL) != 0 {
        let err = std::io::Error::last_os_error();
        if err.raw_os_error() != Some(libc::ESRCH) {
          return Err(format!(
            "Failed to force terminate process group for pid {pid}: {err}"
          ));
        }
      }
    }
  }

  Ok(())
}

fn build_shell_command(script: &str) -> Command {
  #[cfg(target_os = "windows")]
  {
    let mut command = Command::new("cmd");
    command.arg("/C").arg(script);
    return command;
  }

  #[cfg(not(target_os = "windows"))]
  {
    let mut command = Command::new("sh");
    command.arg("-lc").arg(script);
    return command;
  }

  #[allow(unreachable_code)]
  Command::new("true")
}

fn main() {
  tauri::Builder::default()
    .setup(|app| {
      let paths = resolve_paths(app.handle()).map_err(|err| err.to_string())?;
      ensure_dirs(&paths).map_err(|err| err.to_string())?;
      let db = tauri::async_runtime::block_on(Database::connect(&paths))
        .map_err(|err| err.to_string())?;
      tauri::async_runtime::block_on(settings::ensure_defaults(db.pool()))
        .map_err(|err| err.to_string())?;
      app.manage(paths);
      let sidecar_manager = SidecarManager::new(app.handle().clone(), db.clone());
      app.manage(db);
      app.manage(RunManager::default());
      app.manage(TerminalManager::default());
      app.manage(sidecar_manager);
      app.manage(SpotlightManager::default());
      Ok(())
    })
    .plugin(tauri_plugin_dialog::init())
    .on_window_event(|window, event| {
      if let tauri::WindowEvent::CloseRequested { .. } = event {
        let sidecar = window.app_handle().state::<SidecarManager>().inner().clone();
        tauri::async_runtime::spawn(async move {
          sidecar.shutdown_all().await;
        });
      }
    })
    .invoke_handler(tauri::generate_handler![
      hello,
      getAppInfo,
      listSettings,
      setSetting,
      getEnvVars,
      setEnvVars,
      listRepos,
      addRepo,
      removeRepo,
      listWorkspaces,
      listSessions,
      createWorkspace,
      createSession,
      updateSessionModel,
      archiveWorkspace,
      deleteSession,
      unarchiveWorkspace,
      listSessionMessages,
      listSessionAttachments,
      createAttachment,
      deleteAttachment,
      pinWorkspace,
      markWorkspaceUnread,
      sendSessionMessage,
      cancelSession,
      resetSessionToTurn,
      updatePermissionMode,
      respondAskUserQuestion,
      respondExitPlanMode,
      setWorkspaceSparseCheckout,
      setWorkspaceLinkedWorkspaces,
      listWorkspaceFiles,
      readWorkspaceFile,
      getWorkspaceNotes,
      setWorkspaceNotes,
      getWorkspaceTodos,
      setWorkspaceTodos,
      getWorkspaceGitStatus,
      getBranchSyncStatus,
      getWorkspaceDiff,
      getGithubAuthStatus,
      getSpotlightStatus,
      enableSpotlight,
      disableSpotlight,
      listRepoBranches,
      setWorkspaceTargetBranch,
      createPullRequest,
      mergePullRequest,
      getPullRequestStatus,
      getPullRequestFailureLogs,
      fetchPullRequestComments,
      startRunScript,
      stopRunScript,
      createTerminal,
      writeTerminal,
      resizeTerminal,
      closeTerminal,
      openPathIn
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
