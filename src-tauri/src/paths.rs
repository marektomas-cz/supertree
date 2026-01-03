use serde::Serialize;
use std::fmt;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Manager;

/// Resolved filesystem locations used by the Supertree app.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPaths {
  /// Root application data directory for Supertree.
  pub app_data_dir: PathBuf,
  /// Directory where runtime logs are stored.
  pub logs_dir: PathBuf,
  /// Directory that holds workspace checkouts/worktrees.
  pub workspaces_dir: PathBuf,
  /// Directory for bundled or downloaded tools.
  pub tools_dir: PathBuf,
  /// Path to the SQLite database file.
  pub db_path: PathBuf,
}

/// Errors that can occur while resolving or creating app paths.
#[derive(Debug)]
pub enum PathError {
  /// A path could not be resolved by Tauri.
  Resolve(String),
  /// An IO operation failed while creating directories.
  Io(std::io::Error),
}

impl fmt::Display for PathError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      PathError::Resolve(message) => write!(f, "Path resolve error: {message}"),
      PathError::Io(err) => write!(f, "Path IO error: {err}"),
    }
  }
}

impl std::error::Error for PathError {
  fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
    match self {
      PathError::Resolve(_) => None,
      PathError::Io(err) => Some(err),
    }
  }
}

impl From<std::io::Error> for PathError {
  fn from(err: std::io::Error) -> Self {
    PathError::Io(err)
  }
}

/// Resolve app data directories and database path for the current runtime.
pub fn resolve_paths(app: &AppHandle) -> Result<AppPaths, PathError> {
  let app_data_dir = app
    .path()
    .app_data_dir()
    .map_err(|err| PathError::Resolve(err.to_string()))?;
  let logs_dir = app_data_dir.join("logs");
  let workspaces_dir = app_data_dir.join("workspaces");
  let tools_dir = app_data_dir.join("tools");
  let db_path = app_data_dir.join("db.sqlite");

  Ok(AppPaths {
    app_data_dir,
    logs_dir,
    workspaces_dir,
    tools_dir,
    db_path,
  })
}

/// Create the on-disk directories required by the app if missing.
pub fn ensure_dirs(paths: &AppPaths) -> Result<(), PathError> {
  std::fs::create_dir_all(&paths.app_data_dir)?;
  std::fs::create_dir_all(&paths.logs_dir)?;
  std::fs::create_dir_all(&paths.workspaces_dir)?;
  std::fs::create_dir_all(&paths.tools_dir)?;
  Ok(())
}
