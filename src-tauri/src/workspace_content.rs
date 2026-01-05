use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

const NOTES_FILE_NAME: &str = "notes.md";
const TODOS_FILE_NAME: &str = "todos.json";
const TODOS_FILE_VERSION: u32 = 1;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ManualTodoItem {
  pub id: String,
  pub text: String,
  pub completed: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct TodosFile {
  version: u32,
  items: Vec<ManualTodoItem>,
}

fn context_dir(workspace_path: &Path) -> PathBuf {
  workspace_path.join(".context")
}

pub fn read_notes(workspace_path: &Path) -> Result<String, String> {
  let path = context_dir(workspace_path).join(NOTES_FILE_NAME);
  if !path.exists() {
    return Ok(String::new());
  }
  fs::read_to_string(&path)
    .map_err(|err| format!("Failed to read notes: {err}"))
}

pub fn write_notes(workspace_path: &Path, content: &str) -> Result<(), String> {
  let path = context_dir(workspace_path).join(NOTES_FILE_NAME);
  write_atomic(&path, content.as_bytes(), "notes")
}

pub fn read_todos(workspace_path: &Path) -> Result<Vec<ManualTodoItem>, String> {
  let path = context_dir(workspace_path).join(TODOS_FILE_NAME);
  if !path.exists() {
    return Ok(Vec::new());
  }
  let raw = fs::read_to_string(&path)
    .map_err(|err| format!("Failed to read todos: {err}"))?;
  let parsed: TodosFile = serde_json::from_str(&raw)
    .map_err(|err| format!("Failed to parse todos: {err}"))?;
  if parsed.version != TODOS_FILE_VERSION {
    return Err(format!(
      "Unsupported todos version: {}",
      parsed.version
    ));
  }
  Ok(parsed.items)
}

pub fn write_todos(
  workspace_path: &Path,
  items: &[ManualTodoItem],
) -> Result<(), String> {
  let payload = TodosFile {
    version: TODOS_FILE_VERSION,
    items: items.to_vec(),
  };
  let serialized = serde_json::to_string_pretty(&payload)
    .map_err(|err| format!("Failed to serialize todos: {err}"))?;
  let path = context_dir(workspace_path).join(TODOS_FILE_NAME);
  write_atomic(&path, serialized.as_bytes(), "todos")
}

fn write_atomic(path: &Path, contents: &[u8], label: &str) -> Result<(), String> {
  let parent = path
    .parent()
    .ok_or_else(|| format!("Failed to write {label}: missing parent directory"))?;
  fs::create_dir_all(parent)
    .map_err(|err| format!("Failed to create {label} directory: {err}"))?;

  let file_name = path
    .file_name()
    .and_then(|name| name.to_str())
    .unwrap_or("tmp");
  let stamp = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map_err(|err| format!("Failed to write {label}: {err}"))?
    .as_nanos();
  let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
  let tmp_path = parent.join(format!("{file_name}.tmp.{stamp}.{counter}"));

  let mut file = fs::File::create(&tmp_path)
    .map_err(|err| format!("Failed to write {label}: {err}"))?;
  file
    .write_all(contents)
    .map_err(|err| format!("Failed to write {label}: {err}"))?;
  file
    .sync_all()
    .map_err(|err| format!("Failed to flush {label}: {err}"))?;

  fs::rename(&tmp_path, path)
    .map_err(|err| format!("Failed to persist {label}: {err}"))
}
