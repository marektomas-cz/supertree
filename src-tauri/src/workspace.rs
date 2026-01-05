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
  pub setup_log_path: Option<String>,
  pub archive_log_path: Option<String>,
  pub intended_target_branch: Option<String>,
  pub pr_number: Option<i64>,
  pub pr_url: Option<String>,
  pub pr_last_comment_id: Option<String>,
  pub linked_workspace_ids: Option<Vec<String>>,
}

#[derive(Debug, sqlx::FromRow)]
struct WorkspaceRow {
  id: String,
  repo_id: String,
  branch: String,
  directory_name: Option<String>,
  path: String,
  state: String,
  pinned_at: Option<String>,
  unread: bool,
  base_port: Option<i64>,
  setup_log_path: Option<String>,
  archive_log_path: Option<String>,
  intended_target_branch: Option<String>,
  pr_number: Option<i64>,
  pr_url: Option<String>,
  pr_last_comment_id: Option<String>,
  linked_workspace_ids: Option<String>,
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
  pub setup_log_path: Option<String>,
  pub archive_log_path: Option<String>,
  pub intended_target_branch: Option<String>,
  pub pr_number: Option<i64>,
  pub pr_url: Option<String>,
  pub pr_last_comment_id: Option<String>,
}

impl WorkspaceRow {
  fn into_record(self) -> Result<WorkspaceRecord, DbError> {
    let linked_workspace_ids = parse_linked_workspace_ids(self.linked_workspace_ids)?;
    Ok(WorkspaceRecord {
      id: self.id,
      repo_id: self.repo_id,
      branch: self.branch,
      directory_name: self.directory_name,
      path: self.path,
      state: self.state,
      pinned_at: self.pinned_at,
      unread: self.unread,
      base_port: self.base_port,
      setup_log_path: self.setup_log_path,
      archive_log_path: self.archive_log_path,
      intended_target_branch: self.intended_target_branch,
      pr_number: self.pr_number,
      pr_url: self.pr_url,
      pr_last_comment_id: self.pr_last_comment_id,
      linked_workspace_ids,
    })
  }
}

fn parse_linked_workspace_ids(
  raw: Option<String>,
) -> Result<Option<Vec<String>>, DbError> {
  let Some(raw) = raw else {
    return Ok(None);
  };
  let trimmed = raw.trim();
  if trimmed.is_empty() {
    return Ok(None);
  }
  let parsed: Vec<String> = serde_json::from_str(trimmed).map_err(|err| {
    DbError::Parse(format!("Invalid linked workspace ids JSON: {err}"))
  })?;
  Ok(Some(parsed))
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
  let rows = sqlx::query_as::<_, WorkspaceRow>(
    "SELECT id, repo_id, branch, directory_name, path, state, pinned_at, unread, base_port
            , setup_log_path, archive_log_path, intended_target_branch, pr_number, pr_url, pr_last_comment_id,
            linked_workspace_ids
     FROM workspaces
     ORDER BY created_at DESC",
  )
  .fetch_all(pool)
  .await?;
  rows
    .into_iter()
    .map(|row| row.into_record())
    .collect::<Result<Vec<_>, DbError>>()
}

pub async fn get_workspace(pool: &SqlitePool, workspace_id: &str) -> Result<WorkspaceRecord, DbError> {
  let row = sqlx::query_as::<_, WorkspaceRow>(
    "SELECT id, repo_id, branch, directory_name, path, state, pinned_at, unread, base_port
            , setup_log_path, archive_log_path, intended_target_branch, pr_number, pr_url, pr_last_comment_id,
            linked_workspace_ids
     FROM workspaces
     WHERE id = ?",
  )
  .bind(workspace_id)
  .fetch_optional(pool)
  .await?;
  let Some(row) = row else {
    return Err(DbError::NotFound(format!("Workspace not found: {workspace_id}")));
  };
  row.into_record()
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
  let result = sqlx::query(
    "INSERT INTO workspaces
      (id, repo_id, branch, directory_name, path, state, base_port, setup_log_path, archive_log_path,
       intended_target_branch, pr_number, pr_url, pr_last_comment_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
  .bind(&new_workspace.id)
  .bind(&new_workspace.repo_id)
  .bind(&new_workspace.branch)
  .bind(&new_workspace.directory_name)
  .bind(&new_workspace.path)
  .bind(&new_workspace.state)
  .bind(new_workspace.base_port)
  .bind(&new_workspace.setup_log_path)
  .bind(&new_workspace.archive_log_path)
  .bind(&new_workspace.intended_target_branch)
  .bind(new_workspace.pr_number)
  .bind(&new_workspace.pr_url)
  .bind(&new_workspace.pr_last_comment_id)
  .execute(pool)
  .await;
  match result {
    Ok(_) => {}
    Err(sqlx::Error::Database(db_err)) if db_err.is_unique_violation() => {
      return Err(DbError::Conflict(format!(
        "Workspace already exists for branch {}",
        new_workspace.branch
      )));
    }
    Err(err) => return Err(err.into()),
  }

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

pub async fn set_workspace_archive_log_path(
  pool: &SqlitePool,
  workspace_id: &str,
  log_path: &str,
) -> Result<(), DbError> {
  let result = sqlx::query(
    "UPDATE workspaces
     SET archive_log_path = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?",
  )
  .bind(log_path)
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

pub async fn set_workspace_target_branch(
  pool: &SqlitePool,
  workspace_id: &str,
  target_branch: Option<&str>,
) -> Result<(), DbError> {
  let result = sqlx::query(
    "UPDATE workspaces
     SET intended_target_branch = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?",
  )
  .bind(target_branch)
  .bind(workspace_id)
  .execute(pool)
  .await?;
  if result.rows_affected() == 0 {
    return Err(DbError::NotFound(format!("Workspace not found: {workspace_id}")));
  }
  Ok(())
}

pub async fn set_workspace_pr_info(
  pool: &SqlitePool,
  workspace_id: &str,
  pr_number: Option<i64>,
  pr_url: Option<&str>,
) -> Result<(), DbError> {
  let result = sqlx::query(
    "UPDATE workspaces
     SET pr_number = ?, pr_url = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?",
  )
  .bind(pr_number)
  .bind(pr_url)
  .bind(workspace_id)
  .execute(pool)
  .await?;
  if result.rows_affected() == 0 {
    return Err(DbError::NotFound(format!("Workspace not found: {workspace_id}")));
  }
  Ok(())
}

pub async fn set_workspace_pr_last_comment_id(
  pool: &SqlitePool,
  workspace_id: &str,
  last_comment_id: Option<&str>,
) -> Result<(), DbError> {
  let result = sqlx::query(
    "UPDATE workspaces
     SET pr_last_comment_id = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?",
  )
  .bind(last_comment_id)
  .bind(workspace_id)
  .execute(pool)
  .await?;
  if result.rows_affected() == 0 {
    return Err(DbError::NotFound(format!("Workspace not found: {workspace_id}")));
  }
  Ok(())
}

pub async fn set_workspace_linked_workspace_ids(
  pool: &SqlitePool,
  workspace_id: &str,
  linked_ids_json: Option<&str>,
) -> Result<(), DbError> {
  let result = sqlx::query(
    "UPDATE workspaces
     SET linked_workspace_ids = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?",
  )
  .bind(linked_ids_json)
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
