#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod db;
mod git;
mod paths;
mod repos;
mod settings;

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;

use crate::db::Database;
use crate::git::{clone_repo, inspect_repo, is_git_repo, read_supertree_config, repo_name_from_url};
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

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum AddRepoRequest {
  Local { path: String },
  Clone { url: String, destination: Option<String> },
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
    .unwrap_or_else(|_| paths.workspaces_dir.clone());
  let workspace_paths = repos::list_workspace_paths(db.pool(), &repo_id)
    .await
    .map_err(|err| err.to_string())?;
  for workspace_path in workspace_paths {
    let candidate = PathBuf::from(&workspace_path);
    let resolved = candidate
      .canonicalize()
      .unwrap_or_else(|_| candidate.clone());
    if !resolved.starts_with(&workspace_root) {
      return Err(format!(
        "Refusing to delete workspace outside managed directory: {}",
        resolved.display()
      ));
    }
    if resolved.exists() {
      fs::remove_dir_all(&resolved).map_err(|err| err.to_string())?;
    }
  }
  repos::delete_repo(db.pool(), &repo_id)
    .await
    .map_err(|err| err.to_string())
}

#[allow(non_snake_case)]
#[tauri::command]
fn openPathIn(path: String, target: OpenTarget) -> Result<(), String> {
  let path = PathBuf::from(path);
  if !path.exists() {
    return Err(format!("Path does not exist: {}", path.display()));
  }

  let mut command = if cfg!(target_os = "windows") {
    match target {
      OpenTarget::System => {
        let mut cmd = Command::new("explorer");
        cmd.arg(&path);
        cmd
      }
      OpenTarget::Vscode => {
        let mut cmd = Command::new("code");
        cmd.arg(&path);
        cmd
      }
      OpenTarget::Cursor => {
        let mut cmd = Command::new("cursor");
        cmd.arg(&path);
        cmd
      }
      OpenTarget::Zed => {
        let mut cmd = Command::new("zed");
        cmd.arg(&path);
        cmd
      }
    }
  } else if cfg!(target_os = "macos") {
    match target {
      OpenTarget::System => {
        let mut cmd = Command::new("open");
        cmd.arg(&path);
        cmd
      }
      OpenTarget::Vscode => {
        let mut cmd = Command::new("open");
        cmd.arg("-a").arg("Visual Studio Code").arg(&path);
        cmd
      }
      OpenTarget::Cursor => {
        let mut cmd = Command::new("open");
        cmd.arg("-a").arg("Cursor").arg(&path);
        cmd
      }
      OpenTarget::Zed => {
        let mut cmd = Command::new("open");
        cmd.arg("-a").arg("Zed").arg(&path);
        cmd
      }
    }
  } else {
    match target {
      OpenTarget::System => {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(&path);
        cmd
      }
      OpenTarget::Vscode => {
        let mut cmd = Command::new("code");
        cmd.arg(&path);
        cmd
      }
      OpenTarget::Cursor => {
        let mut cmd = Command::new("cursor");
        cmd.arg(&path);
        cmd
      }
      OpenTarget::Zed => {
        let mut cmd = Command::new("zed");
        cmd.arg(&path);
        cmd
      }
    }
  };

  let status = command.status().map_err(|err| err.to_string())?;
  if !status.success() {
    return Err(format!(
      "Open command failed with exit code {:?}",
      status.code()
    ));
  }
  Ok(())
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
      openPathIn
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
