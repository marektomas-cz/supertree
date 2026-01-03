use serde::Serialize;
use std::fmt;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Manager;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPaths {
  pub app_data_dir: PathBuf,
  pub logs_dir: PathBuf,
  pub workspaces_dir: PathBuf,
  pub tools_dir: PathBuf,
  pub db_path: PathBuf,
}

#[derive(Debug)]
pub enum PathError {
  Resolve(String),
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

impl std::error::Error for PathError {}

impl From<std::io::Error> for PathError {
  fn from(err: std::io::Error) -> Self {
    PathError::Io(err)
  }
}

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

pub fn ensure_dirs(paths: &AppPaths) -> Result<(), PathError> {
  std::fs::create_dir_all(&paths.app_data_dir)?;
  std::fs::create_dir_all(&paths.logs_dir)?;
  std::fs::create_dir_all(&paths.workspaces_dir)?;
  std::fs::create_dir_all(&paths.tools_dir)?;
  Ok(())
}
