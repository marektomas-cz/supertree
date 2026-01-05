use crate::paths::AppPaths;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqliteSynchronous};
use sqlx::SqlitePool;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::process;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
  /// Data could not be parsed into the expected shape.
  Parse(String),
  /// A record already exists and cannot be created again.
  Conflict(String),
  /// A requested record does not exist.
  NotFound(String),
}

impl fmt::Display for DbError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      DbError::Sqlx(err) => write!(f, "Database error: {err}"),
      DbError::Migrate(err) => write!(f, "Database migration error: {err}"),
      DbError::InvalidPath(message) => write!(f, "Database path error: {message}"),
      DbError::Parse(message) => write!(f, "Database parse error: {message}"),
      DbError::Conflict(message) => write!(f, "Database conflict: {message}"),
      DbError::NotFound(message) => write!(f, "Database not found: {message}"),
    }
  }
}

impl std::error::Error for DbError {
  fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
    match self {
      DbError::Sqlx(err) => Some(err),
      DbError::Migrate(err) => Some(err),
      DbError::InvalidPath(_) => None,
      DbError::Parse(_) => None,
      DbError::Conflict(_) => None,
      DbError::NotFound(_) => None,
    }
  }
}

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
    let pool = SqlitePool::connect_with(sqlite_options(db_path)).await?;
    if let Err(err) = sqlx::migrate!().run(&pool).await {
      if cfg!(debug_assertions) && is_migration_version_mismatch(&err) {
        eprintln!(
          "[db] Migration checksum mismatch detected in debug. Resetting dev database at {}.",
          db_path.display()
        );
        pool.close().await;
        let backup_path = reset_dev_db(db_path)?;
        if let Some(path) = &backup_path {
          eprintln!(
            "[db] Dev database reset complete. Backup stored at {} (original {}).",
            path.display(),
            db_path.display()
          );
        }
        let pool = SqlitePool::connect_with(sqlite_options(db_path)).await?;
        sqlx::migrate!().run(&pool).await?;
        return Ok(Self { pool });
      }
      return Err(err.into());
    }

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

fn sqlite_options(path: &Path) -> SqliteConnectOptions {
  SqliteConnectOptions::new()
    .filename(path)
    .create_if_missing(true)
    .journal_mode(SqliteJournalMode::Wal)
    .synchronous(SqliteSynchronous::Normal)
    .foreign_keys(true)
    .busy_timeout(Duration::from_secs(30))
}

fn is_migration_version_mismatch(err: &sqlx::migrate::MigrateError) -> bool {
  matches!(err, sqlx::migrate::MigrateError::VersionMismatch { .. })
}

fn reset_dev_db(db_path: &Path) -> Result<Option<PathBuf>, DbError> {
  if !db_path.exists() {
    return Ok(None);
  }
  let file_name = db_path.file_name().and_then(|name| name.to_str()).ok_or_else(|| {
    DbError::InvalidPath("Database filename is not valid UTF-8".to_string())
  })?;
  let timestamp = match SystemTime::now().duration_since(UNIX_EPOCH) {
    Ok(duration) => duration.as_secs().max(1),
    Err(err) => {
      eprintln!(
        "[db] Failed to compute UNIX timestamp for DB backup: {err}. Falling back to process id."
      );
      u64::from(process::id()).max(1)
    }
  };
  let backup_path = db_path.with_file_name(format!("{file_name}.bak-{timestamp}"));
  fs::rename(db_path, &backup_path).map_err(|err| {
    DbError::InvalidPath(format!("Failed to backup dev database: {err}"))
  })?;
  eprintln!(
    "[db] Dev database backup created at {}.",
    backup_path.display()
  );
  let wal_path = db_path.with_file_name(format!("{file_name}-wal"));
  let shm_path = db_path.with_file_name(format!("{file_name}-shm"));
  let _ = fs::remove_file(wal_path);
  let _ = fs::remove_file(shm_path);
  Ok(Some(backup_path))
}
