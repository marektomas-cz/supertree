#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;

#[tauri::command]
fn hello(name: String) -> String {
  format!("Hello, {}!", name)
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
    .invoke_handler(tauri::generate_handler![hello])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
