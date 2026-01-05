use notify::{recommended_watcher, Event, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{
  atomic::{AtomicBool, Ordering},
  mpsc, Arc, Mutex,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::checkpoints::{create_checkpoint, delete_checkpoint, restore_checkpoint, CheckpointOutcome};

pub struct SpotlightManager {
  instances: Arc<Mutex<HashMap<String, SpotlightInstance>>>,
}

struct SpotlightInstance {
  repo_root: PathBuf,
  rollback_checkpoint_id: String,
  sync_checkpoint_id: String,
  stop_flag: Arc<AtomicBool>,
  trigger_tx: mpsc::Sender<()>,
  join: Option<JoinHandle<()>>,
}

impl Default for SpotlightManager {
  fn default() -> Self {
    Self {
      instances: Arc::new(Mutex::new(HashMap::new())),
    }
  }
}

impl SpotlightManager {
  pub fn is_active(&self, workspace_id: &str) -> bool {
    self
      .instances
      .lock()
      .map(|map| map.contains_key(workspace_id))
      .unwrap_or(false)
  }

  pub fn enable(
    &self,
    workspace_id: &str,
    workspace_path: PathBuf,
    repo_root: PathBuf,
  ) -> Result<(), String> {
    if workspace_path == repo_root {
      return Err("Spotlight requires a separate worktree path".to_string());
    }
    let mut map = self
      .instances
      .lock()
      .map_err(|_| "Spotlight state locked".to_string())?;
    if map.contains_key(workspace_id) {
      return Ok(());
    }
    if map.values().any(|item| item.repo_root == repo_root) {
      return Err("Spotlight already active for this repository".to_string());
    }

    let stamp = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .map_err(|err| format!("Failed to read time: {err}"))?
      .as_secs();
    let rollback_checkpoint_id = format!("spotlight-rollback-{}-{}", workspace_id, stamp);
    match create_checkpoint(&repo_root, &rollback_checkpoint_id) {
      Ok(CheckpointOutcome::Created) => {}
      Ok(CheckpointOutcome::Skipped { reason }) => {
        return Err(format!("Spotlight cannot start: {reason}"));
      }
      Err(err) => {
        return Err(format!("Spotlight failed to create rollback checkpoint: {err}"));
      }
    }

    let sync_checkpoint_id = format!("spotlight-sync-{}", workspace_id);
    let (trigger_tx, trigger_rx) = mpsc::channel::<()>();
    let (init_tx, init_rx) = mpsc::channel::<Result<(), String>>();
    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_flag_worker = stop_flag.clone();
    let stop_flag_watcher = stop_flag.clone();
    let workspace_clone = workspace_path.clone();
    let repo_clone = repo_root.clone();
    let sync_id_clone = sync_checkpoint_id.clone();

    let trigger_tx_worker = trigger_tx.clone();
    let join = thread::spawn(move || {
      let trigger_tx_watcher = trigger_tx_worker.clone();
      let mut watcher = match recommended_watcher(move |res: Result<Event, notify::Error>| {
        if stop_flag_watcher.load(Ordering::Relaxed) {
          return;
        }
        if let Ok(event) = res {
          if should_ignore_event(&event) {
            return;
          }
          let _ = trigger_tx_watcher.send(());
        }
      }) {
        Ok(watcher) => watcher,
        Err(err) => {
          let _ = init_tx.send(Err(format!("Spotlight watcher error: {err}")));
          return;
        }
      };

      if let Err(err) = watcher.watch(&workspace_clone, RecursiveMode::Recursive) {
        let _ = init_tx.send(Err(format!("Spotlight failed to watch workspace: {err}")));
        return;
      }

      let _ = init_tx.send(Ok(()));
      let _ = trigger_tx_worker.send(());

      loop {
        if stop_flag_worker.load(Ordering::Relaxed) {
          break;
        }
        match trigger_rx.recv_timeout(Duration::from_millis(500)) {
          Ok(()) => {
            while trigger_rx.try_recv().is_ok() {}
            if stop_flag_worker.load(Ordering::Relaxed) {
              break;
            }
            run_sync(&workspace_clone, &repo_clone, &sync_id_clone);
          }
          Err(mpsc::RecvTimeoutError::Timeout) => {}
          Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
      }
    });

    let init_result = init_rx
      .recv_timeout(Duration::from_secs(3))
      .map_err(|_| "Spotlight failed to initialize watcher".to_string())?;
    if let Err(err) = init_result {
      stop_flag.store(true, Ordering::Relaxed);
      let _ = trigger_tx.send(());
      let _ = join.join();
      let _ = delete_checkpoint(&repo_root, &rollback_checkpoint_id);
      return Err(err);
    }

    let instance = SpotlightInstance {
      repo_root,
      rollback_checkpoint_id,
      sync_checkpoint_id,
      stop_flag,
      trigger_tx,
      join: Some(join),
    };

    map.insert(workspace_id.to_string(), instance);
    Ok(())
  }

  pub fn disable(&self, workspace_id: &str) -> Result<(), String> {
    let instance = {
      let mut map = self
        .instances
        .lock()
        .map_err(|_| "Spotlight state locked".to_string())?;
      map.remove(workspace_id)
    };
    let Some(mut instance) = instance else {
      return Ok(());
    };
    instance.stop_flag.store(true, Ordering::Relaxed);
    let _ = instance.trigger_tx.send(());
    if let Some(join) = instance.join.take() {
      let _ = join.join();
    }

    restore_checkpoint(&instance.repo_root, &instance.rollback_checkpoint_id)
      .map_err(|err| format!("Failed to restore rollback checkpoint: {err}"))?;

    let mut cleanup_errors: Vec<String> = Vec::new();
    if let Err(err) = delete_checkpoint(&instance.repo_root, &instance.rollback_checkpoint_id) {
      cleanup_errors.push(format!("Rollback checkpoint cleanup failed: {err}"));
    }
    if let Err(err) = delete_checkpoint(&instance.repo_root, &instance.sync_checkpoint_id) {
      cleanup_errors.push(format!("Spotlight checkpoint cleanup failed: {err}"));
    }
    if !cleanup_errors.is_empty() {
      return Err(cleanup_errors.join(" | "));
    }
    Ok(())
  }
}

fn run_sync(workspace_path: &Path, repo_root: &Path, checkpoint_id: &str) {
  match create_checkpoint(workspace_path, checkpoint_id) {
    Ok(CheckpointOutcome::Created) => {}
    Ok(CheckpointOutcome::Skipped { reason }) => {
      eprintln!("[spotlight] sync skipped: {reason}");
      return;
    }
    Err(err) => {
      eprintln!("[spotlight] sync checkpoint failed: {err}");
      return;
    }
  }
  if let Err(err) = restore_checkpoint(repo_root, checkpoint_id) {
    eprintln!("[spotlight] restore failed: {err}");
  }
}

fn should_ignore_event(event: &Event) -> bool {
  if event.paths.is_empty() {
    return false;
  }
  event.paths.iter().all(|path| should_ignore_path(path))
}

fn should_ignore_path(path: &Path) -> bool {
  for component in path.components() {
    let name = component.as_os_str();
    if name == ".context" || name == ".git" {
      return true;
    }
  }
  let file_name = path.file_name().and_then(|value| value.to_str());
  if let Some(name) = file_name {
    if name.contains(".tmp.") {
      return true;
    }
  }
  false
}
