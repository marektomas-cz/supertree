#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod db;
mod paths;
mod settings;

use serde::Serialize;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;

use crate::db::Database;
use crate::paths::{AppPaths, ensure_dirs, resolve_paths};
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
      setEnvVars
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
