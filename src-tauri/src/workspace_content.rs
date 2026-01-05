use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

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
  let dir = context_dir(workspace_path);
  fs::create_dir_all(&dir)
    .map_err(|err| format!("Failed to create notes directory: {err}"))?;
  let path = dir.join(NOTES_FILE_NAME);
  fs::write(&path, content)
    .map_err(|err| format!("Failed to write notes: {err}"))
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
  let dir = context_dir(workspace_path);
  fs::create_dir_all(&dir)
    .map_err(|err| format!("Failed to create todos directory: {err}"))?;
  let payload = TodosFile {
    version: TODOS_FILE_VERSION,
    items: items.to_vec(),
  };
  let serialized = serde_json::to_string_pretty(&payload)
    .map_err(|err| format!("Failed to serialize todos: {err}"))?;
  let path = dir.join(TODOS_FILE_NAME);
  fs::write(&path, serialized)
    .map_err(|err| format!("Failed to write todos: {err}"))
}
