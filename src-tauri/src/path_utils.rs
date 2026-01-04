use std::path::{Component, Path, PathBuf};

pub fn normalize_relative_path(path: &Path) -> Result<PathBuf, String> {
  let mut normalized = PathBuf::new();
  for component in path.components() {
    match component {
      Component::CurDir => {}
      Component::Normal(value) => normalized.push(value),
      Component::ParentDir => {
        if !normalized.pop() {
          return Err("File is outside workspace".to_string());
        }
      }
      Component::RootDir | Component::Prefix(_) => {
        return Err("Path must be workspace-relative".to_string());
      }
    }
  }
  Ok(normalized)
}
