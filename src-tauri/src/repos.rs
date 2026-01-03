use crate::db::DbError;
use serde::Serialize;
use sqlx::SqlitePool;

/// Repository record stored in SQLite.
#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct RepoRecord {
  /// Repository id.
  pub id: String,
  /// Display name of the repository.
  pub name: String,
  /// Absolute path to the repository root.
  pub root_path: String,
  /// Remote URL if configured.
  pub remote_url: Option<String>,
  /// Default branch name.
  pub default_branch: String,
  /// Script to run during setup.
  pub scripts_setup: Option<String>,
  /// Script to run for launch.
  pub scripts_run: Option<String>,
  /// Script to archive the repo.
  pub scripts_archive: Option<String>,
  /// Script run mode.
  pub run_script_mode: Option<String>,
}

/// Data required to insert a new repository.
pub struct NewRepo {
  pub name: String,
  pub root_path: String,
  pub remote_url: Option<String>,
  pub default_branch: String,
  pub scripts_setup: Option<String>,
  pub scripts_run: Option<String>,
  pub scripts_archive: Option<String>,
  pub run_script_mode: Option<String>,
}

/// List repositories ordered by name.
pub async fn list_repos(pool: &SqlitePool) -> Result<Vec<RepoRecord>, DbError> {
  let rows = sqlx::query_as::<_, RepoRecord>(
    "SELECT id, name, root_path, remote_url, default_branch,
            scripts_setup, scripts_run, scripts_archive, run_script_mode
     FROM repos
     ORDER BY name",
  )
  .fetch_all(pool)
  .await?;
  Ok(rows)
}

/// Fetch a repository by id.
pub async fn get_repo_by_id(pool: &SqlitePool, repo_id: &str) -> Result<RepoRecord, DbError> {
  let row = sqlx::query_as::<_, RepoRecord>(
    "SELECT id, name, root_path, remote_url, default_branch,
            scripts_setup, scripts_run, scripts_archive, run_script_mode
     FROM repos
     WHERE id = ?",
  )
  .bind(repo_id)
  .fetch_optional(pool)
  .await?;
  row.ok_or_else(|| DbError::NotFound(format!("Repository not found: {repo_id}")))
}

/// Insert a new repository record.
pub async fn insert_repo(pool: &SqlitePool, new_repo: NewRepo) -> Result<RepoRecord, DbError> {
  let existing: Option<String> =
    sqlx::query_scalar("SELECT id FROM repos WHERE root_path = ?")
      .bind(&new_repo.root_path)
      .fetch_optional(pool)
      .await?;
  if existing.is_some() {
    return Err(DbError::Conflict(format!(
      "Repository already exists at {}",
      new_repo.root_path
    )));
  }

  let id: String = sqlx::query_scalar("SELECT lower(hex(randomblob(16)))")
    .fetch_one(pool)
    .await?;

  sqlx::query(
    "INSERT INTO repos
      (id, name, root_path, remote_url, default_branch,
       scripts_setup, scripts_run, scripts_archive, run_script_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
  .bind(&id)
  .bind(&new_repo.name)
  .bind(&new_repo.root_path)
  .bind(&new_repo.remote_url)
  .bind(&new_repo.default_branch)
  .bind(&new_repo.scripts_setup)
  .bind(&new_repo.scripts_run)
  .bind(&new_repo.scripts_archive)
  .bind(&new_repo.run_script_mode)
  .execute(pool)
  .await?;

  let row = sqlx::query_as::<_, RepoRecord>(
    "SELECT id, name, root_path, remote_url, default_branch,
            scripts_setup, scripts_run, scripts_archive, run_script_mode
     FROM repos
     WHERE id = ?",
  )
  .bind(&id)
  .fetch_one(pool)
  .await?;
  Ok(row)
}

/// Remove a repository record by id.
pub async fn delete_repo(pool: &SqlitePool, repo_id: &str) -> Result<(), DbError> {
  let result = sqlx::query("DELETE FROM repos WHERE id = ?")
    .bind(repo_id)
    .execute(pool)
    .await?;
  if result.rows_affected() == 0 {
    return Err(DbError::NotFound(format!(
      "Repository not found: {repo_id}"
    )));
  }
  Ok(())
}

/// List workspace paths for a repository.
pub async fn list_workspace_paths(pool: &SqlitePool, repo_id: &str) -> Result<Vec<String>, DbError> {
  let rows = sqlx::query_scalar::<_, String>("SELECT path FROM workspaces WHERE repo_id = ?")
    .bind(repo_id)
    .fetch_all(pool)
    .await?;
  Ok(rows)
}
