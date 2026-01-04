#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod db;
mod git;
mod paths;
mod repos;
mod settings;
mod workspace;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(unix)]
use libc;

use crate::db::{Database, DbError};
use crate::git::{
  branch_exists, clone_repo, create_worktree, inspect_repo, is_git_repo, read_supertree_config,
  remove_worktree, repo_name_from_url, set_sparse_checkout,
};
use crate::paths::{ensure_dirs, resolve_paths, AppPaths};
use crate::repos::{NewRepo, RepoRecord};
use crate::settings::SettingEntry;

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
enum OpenTarget {
  System,
  Vscode,
  Cursor,
  Zed,
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
      let value = value.trim().trim_matches('"').trim_matches('\'');
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

struct SidecarProcess {
  child: Mutex<Option<Child>>,
}

impl SidecarProcess {
  fn spawn() -> Result<Self, String> {
    let entry = sidecar_entry()?;
    if !entry.exists() {
      let mut attempts = 0;
      while attempts < 15 && !entry.exists() {
        std::thread::sleep(Duration::from_millis(200));
        attempts += 1;
      }
    }
    if !entry.exists() {
      return Err(format!(
        "Sidecar bundle not found at {}. Run `npm --prefix sidecar run build`.",
        entry.display()
      ));
    }

    let mut child = Command::new("node")
      .arg(entry)
      .stdout(Stdio::piped())
      .stderr(Stdio::piped())
      .spawn()
      .map_err(|err| format!("Failed to spawn sidecar: {err}"))?;

    if let Some(stdout) = child.stdout.take() {
      spawn_output_logger(stdout, "sidecar");
    }
    if let Some(stderr) = child.stderr.take() {
      spawn_output_logger(stderr, "sidecar-error");
    }

    Ok(Self {
      child: Mutex::new(Some(child)),
    })
  }
}

impl Drop for SidecarProcess {
  fn drop(&mut self) {
    let Ok(mut guard) = self.child.lock() else {
      eprintln!("Sidecar lock poisoned during shutdown");
      return;
    };

    if let Some(mut child) = guard.take() {
      if let Err(err) = child.kill() {
        eprintln!("Failed to stop sidecar: {err}");
      } else if let Err(err) = child.wait() {
        eprintln!("Failed to wait for sidecar exit: {err}");
      }
    }
  }
}

fn spawn_output_logger(reader: impl Read + Send + 'static, label: &'static str) {
  std::thread::spawn(move || {
    let buffer = BufReader::new(reader);
    for line in buffer.lines() {
      match line {
        Ok(line) => println!("[{label}] {line}"),
        Err(err) => eprintln!("[{label}] output error: {err}"),
      }
    }
  });
}

fn sidecar_entry() -> Result<PathBuf, String> {
  let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
  let root = manifest_dir
    .parent()
    .ok_or_else(|| "Missing project root".to_string())?;
  Ok(root.join("sidecar").join("dist").join("index.js"))
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
      app.manage(db);
      app.manage(RunManager::default());
      app.manage(TerminalManager::default());
      if cfg!(debug_assertions) {
        match SidecarProcess::spawn() {
          Ok(process) => {
            app.manage(process);
          }
          Err(err) => {
            eprintln!("Sidecar spawn skipped: {err}");
          }
        }
      }
      Ok(())
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
      createWorkspace,
      archiveWorkspace,
      unarchiveWorkspace,
      pinWorkspace,
      markWorkspaceUnread,
      setWorkspaceSparseCheckout,
      listWorkspaceFiles,
      readWorkspaceFile,
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
