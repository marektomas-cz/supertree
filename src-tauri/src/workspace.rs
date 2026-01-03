use crate::db::DbError;
use serde::Serialize;
use sqlx::SqlitePool;

const WORKSPACE_STATE_ACTIVE: &str = "active";
const WORKSPACE_STATE_ARCHIVED: &str = "archived";
const BASE_PORT_START: i64 = 41000;
const BASE_PORT_STRIDE: i64 = 10;

/// Workspace record stored in SQLite.
#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecord {
  pub id: String,
  pub repo_id: String,
  pub branch: String,
  pub directory_name: Option<String>,
  pub path: String,
  pub state: String,
  pub pinned_at: Option<String>,
  pub unread: bool,
  pub base_port: Option<i64>,
}

/// Data required to insert a new workspace record.
pub struct NewWorkspace {
  pub id: String,
  pub repo_id: String,
  pub branch: String,
  pub directory_name: Option<String>,
  pub path: String,
  pub state: String,
  pub base_port: Option<i64>,
}

pub fn active_state() -> &'static str {
  WORKSPACE_STATE_ACTIVE
}

pub fn archived_state() -> &'static str {
  WORKSPACE_STATE_ARCHIVED
}

pub fn build_directory_name(repo_name: &str, branch: &str, workspace_id: &str) -> String {
  let sanitized_repo = sanitize_segment(repo_name);
  let sanitized_branch = sanitize_segment(branch);
  let short_id = workspace_id.get(0..8).unwrap_or(workspace_id);
  format!("{sanitized_repo}-{sanitized_branch}-{short_id}")
}

pub async fn generate_id(pool: &SqlitePool) -> Result<String, DbError> {
  let id: String = sqlx::query_scalar("SELECT lower(hex(randomblob(16)))")
    .fetch_one(pool)
    .await?;
  Ok(id)
}

pub async fn allocate_base_port(pool: &SqlitePool) -> Result<i64, DbError> {
  let max_port: Option<i64> = sqlx::query_scalar("SELECT MAX(base_port) FROM workspaces")
    .fetch_one(pool)
    .await?;
  let next = match max_port {
    Some(value) if value >= BASE_PORT_START => value + BASE_PORT_STRIDE,
    _ => BASE_PORT_START,
  };
  Ok(next)
}

pub async fn list_workspaces(pool: &SqlitePool) -> Result<Vec<WorkspaceRecord>, DbError> {
  let rows = sqlx::query_as::<_, WorkspaceRecord>(
    "SELECT id, repo_id, branch, directory_name, path, state, pinned_at, unread, base_port
     FROM workspaces
     ORDER BY created_at DESC",
  )
  .fetch_all(pool)
  .await?;
  Ok(rows)
}

pub async fn get_workspace(pool: &SqlitePool, workspace_id: &str) -> Result<WorkspaceRecord, DbError> {
  let row = sqlx::query_as::<_, WorkspaceRecord>(
    "SELECT id, repo_id, branch, directory_name, path, state, pinned_at, unread, base_port
     FROM workspaces
     WHERE id = ?",
  )
  .bind(workspace_id)
  .fetch_optional(pool)
  .await?;
  row.ok_or_else(|| DbError::NotFound(format!("Workspace not found: {workspace_id}")))
}

pub async fn find_active_workspace_for_branch(
  pool: &SqlitePool,
  repo_id: &str,
  branch: &str,
) -> Result<Option<String>, DbError> {
  let row: Option<String> = sqlx::query_scalar(
    "SELECT id FROM workspaces WHERE repo_id = ? AND branch = ? AND state = ?",
  )
  .bind(repo_id)
  .bind(branch)
  .bind(WORKSPACE_STATE_ACTIVE)
  .fetch_optional(pool)
  .await?;
  Ok(row)
}

pub async fn insert_workspace(pool: &SqlitePool, new_workspace: NewWorkspace) -> Result<WorkspaceRecord, DbError> {
  sqlx::query(
    "INSERT INTO workspaces
      (id, repo_id, branch, directory_name, path, state, base_port)
     VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
  .bind(&new_workspace.id)
  .bind(&new_workspace.repo_id)
  .bind(&new_workspace.branch)
  .bind(&new_workspace.directory_name)
  .bind(&new_workspace.path)
  .bind(&new_workspace.state)
  .bind(new_workspace.base_port)
  .execute(pool)
  .await?;

  get_workspace(pool, &new_workspace.id).await
}

pub async fn set_workspace_state(
  pool: &SqlitePool,
  workspace_id: &str,
  state: &str,
) -> Result<(), DbError> {
  let result = sqlx::query(
    "UPDATE workspaces
     SET state = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?",
  )
  .bind(state)
  .bind(workspace_id)
  .execute(pool)
  .await?;
  if result.rows_affected() == 0 {
    return Err(DbError::NotFound(format!("Workspace not found: {workspace_id}")));
  }
  Ok(())
}

pub async fn set_workspace_pinned(
  pool: &SqlitePool,
  workspace_id: &str,
  pinned: bool,
) -> Result<(), DbError> {
  let result = sqlx::query(
    "UPDATE workspaces
     SET pinned_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?",
  )
  .bind(pinned)
  .bind(workspace_id)
  .execute(pool)
  .await?;
  if result.rows_affected() == 0 {
    return Err(DbError::NotFound(format!("Workspace not found: {workspace_id}")));
  }
  Ok(())
}

pub async fn set_workspace_unread(
  pool: &SqlitePool,
  workspace_id: &str,
  unread: bool,
) -> Result<(), DbError> {
  let result = sqlx::query(
    "UPDATE workspaces
     SET unread = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?",
  )
  .bind(unread)
  .bind(workspace_id)
  .execute(pool)
  .await?;
  if result.rows_affected() == 0 {
    return Err(DbError::NotFound(format!("Workspace not found: {workspace_id}")));
  }
  Ok(())
}

fn sanitize_segment(value: &str) -> String {
  let mut output = String::with_capacity(value.len());
  for ch in value.chars() {
    if ch.is_ascii_alphanumeric() || ch == '-' {
      output.push(ch.to_ascii_lowercase());
    } else if ch == '_' {
      output.push('-');
    } else if ch.is_whitespace() || ch == '/' || ch == '\\' || ch == ':' {
      output.push('-');
    }
  }
  if output.is_empty() {
    "workspace".to_string()
  } else {
    output
  }
}

#[cfg(test)]
mod tests {
  use super::build_directory_name;

  #[test]
  fn builds_directory_name_with_sanitized_segments() {
    let name = build_directory_name("Repo Name", "feature/test", "abcdef123456");
    assert!(name.starts_with("repo-name-feature-test-abcdef12"));
  }
}
