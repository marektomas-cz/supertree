#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod db;
mod git;
mod paths;
mod repos;
mod settings;
mod workspace;

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;

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

  let new_workspace = workspace::NewWorkspace {
    id: id.clone(),
    repo_id: repo_id.clone(),
    branch: branch.clone(),
    directory_name: Some(directory_name),
    path: workspace_path.to_string_lossy().to_string(),
    state: workspace::active_state().to_string(),
    base_port: Some(base_port),
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
    run_workspace_script(script, &workspace_path, workspace_record.base_port)?;
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
  let content = String::from_utf8_lossy(&buffer).to_string();
  let relative = resolved
    .strip_prefix(root)
    .map_err(|err| err.to_string())?
    .to_string_lossy()
    .replace('\\', "/");
  Ok(FilePreview {
    path: relative,
    content,
    truncated,
  })
}

fn run_workspace_script(
  script: &str,
  workspace_path: &Path,
  base_port: Option<i64>,
) -> Result<(), String> {
  let mut command = build_shell_command(script);
  command.current_dir(workspace_path);
  if let Some(port) = base_port {
    let value = port.to_string();
    command.env("SUPERTREE_PORT", &value);
    command.env("supertree_PORT", &value);
  }
  let status = command.status().map_err(|err| err.to_string())?;
  if !status.success() {
    return Err(format!(
      "Workspace script failed ({}): exit code {:?}",
      script,
      status.code()
    ));
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
      openPathIn
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
