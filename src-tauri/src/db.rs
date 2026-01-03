use crate::paths::AppPaths;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqliteSynchronous};
use sqlx::SqlitePool;
use std::fmt;
use std::path::Path;
use std::time::Duration;

/// SQLite connection wrapper for the Supertree app.
#[derive(Debug, Clone)]
pub struct Database {
  pool: SqlitePool,
}

/// Errors returned by database initialization and queries.
#[derive(Debug)]
pub enum DbError {
  /// Error produced by sqlx during connection or query execution.
  Sqlx(sqlx::Error),
  /// Error produced by sqlx migrations.
  Migrate(sqlx::migrate::MigrateError),
  /// The database path was invalid or missing.
  InvalidPath(String),
}

impl fmt::Display for DbError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      DbError::Sqlx(err) => write!(f, "Database error: {err}"),
      DbError::Migrate(err) => write!(f, "Database migration error: {err}"),
      DbError::InvalidPath(message) => write!(f, "Database path error: {message}"),
    }
  }
}

impl std::error::Error for DbError {}

impl From<sqlx::Error> for DbError {
  fn from(err: sqlx::Error) -> Self {
    DbError::Sqlx(err)
  }
}

impl From<sqlx::migrate::MigrateError> for DbError {
  fn from(err: sqlx::migrate::MigrateError) -> Self {
    DbError::Migrate(err)
  }
}

impl Database {
  /// Connect to the SQLite database using the resolved app paths.
  pub async fn connect(paths: &AppPaths) -> Result<Self, DbError> {
    let db_path = ensure_db_parent(&paths.db_path)?;
    let options = SqliteConnectOptions::new()
      .filename(db_path)
      .create_if_missing(true)
      .journal_mode(SqliteJournalMode::Wal)
      .synchronous(SqliteSynchronous::Normal)
      .busy_timeout(Duration::from_secs(30));

    let pool = SqlitePool::connect_with(options).await?;
    sqlx::query("PRAGMA foreign_keys = ON;")
      .execute(&pool)
      .await?;
    sqlx::migrate!().run(&pool).await?;

    Ok(Self { pool })
  }

  /// Access the underlying sqlx connection pool.
  pub fn pool(&self) -> &SqlitePool {
    &self.pool
  }
}

fn ensure_db_parent(path: &Path) -> Result<&Path, DbError> {
  let parent = path.parent().ok_or_else(|| {
    DbError::InvalidPath("Database path is missing a parent directory".to_string())
  })?;
  if !parent.exists() {
    return Err(DbError::InvalidPath(format!(
      "Database parent directory does not exist: {}",
      parent.display()
    )));
  }
  Ok(path)
}
