use crate::db::DbError;
use serde::Serialize;
use sqlx::SqlitePool;

/// Session record stored in SQLite.
#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
  pub id: String,
  pub workspace_id: String,
  pub title: Option<String>,
  pub agent_type: String,
  pub model: Option<String>,
  pub status: String,
  pub unread_count: i64,
  pub claude_session_id: Option<String>,
  pub codex_session_id: Option<String>,
  pub context_token_count: Option<i64>,
  pub is_compacted: bool,
}

/// Data required to insert a new session record.
pub struct NewSession {
  pub workspace_id: String,
  pub title: Option<String>,
  pub agent_type: String,
  pub model: Option<String>,
  pub status: String,
}

/// Data required to insert a new session message without a turn id.
#[allow(dead_code)]
pub struct NewSessionMessageDraft {
  pub id: String,
  pub session_id: String,
  pub role: String,
  pub content: String,
  pub metadata_json: Option<String>,
  pub checkpoint_id: Option<String>,
}

/// Session message record stored in SQLite.
#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct SessionMessageRecord {
  pub id: String,
  pub session_id: String,
  pub turn_id: i64,
  pub role: String,
  pub content: String,
  pub sent_at: Option<String>,
  pub cancelled_at: Option<String>,
  pub metadata_json: Option<String>,
  pub checkpoint_id: Option<String>,
}

/// Data required to insert a new session message record.
pub struct NewSessionMessage {
  pub id: String,
  pub session_id: String,
  pub turn_id: i64,
  pub role: String,
  pub content: String,
  pub metadata_json: Option<String>,
  pub checkpoint_id: Option<String>,
}

#[derive(Debug, sqlx::FromRow)]
pub struct SessionMessageCheckpoint {
  pub checkpoint_id: Option<String>,
  pub role: String,
}

pub async fn list_sessions(pool: &SqlitePool) -> Result<Vec<SessionRecord>, DbError> {
  let rows = sqlx::query_as::<_, SessionRecord>(
    "SELECT id, workspace_id, title, agent_type, model, status, unread_count,
            claude_session_id, codex_session_id, context_token_count, is_compacted
     FROM sessions
     ORDER BY created_at DESC",
  )
  .fetch_all(pool)
  .await?;
  Ok(rows)
}

pub async fn insert_session(pool: &SqlitePool, new_session: NewSession) -> Result<SessionRecord, DbError> {
  let id = generate_random_id(pool).await?;

  sqlx::query(
    "INSERT INTO sessions
      (id, workspace_id, title, agent_type, model, status)
     VALUES (?, ?, ?, ?, ?, ?)",
  )
  .bind(&id)
  .bind(&new_session.workspace_id)
  .bind(&new_session.title)
  .bind(&new_session.agent_type)
  .bind(&new_session.model)
  .bind(&new_session.status)
  .execute(pool)
  .await?;

  get_session(pool, &id).await
}

pub async fn get_session(pool: &SqlitePool, session_id: &str) -> Result<SessionRecord, DbError> {
  let row = sqlx::query_as::<_, SessionRecord>(
    "SELECT id, workspace_id, title, agent_type, model, status, unread_count,
            claude_session_id, codex_session_id, context_token_count, is_compacted
     FROM sessions
     WHERE id = ?",
  )
  .bind(session_id)
  .fetch_optional(pool)
  .await?;
  row.ok_or_else(|| DbError::NotFound(format!("Session not found: {session_id}")))
}

pub async fn delete_session(pool: &SqlitePool, session_id: &str) -> Result<(), DbError> {
  let result = sqlx::query("DELETE FROM sessions WHERE id = ?")
    .bind(session_id)
    .execute(pool)
    .await?;
  if result.rows_affected() == 0 {
    return Err(DbError::NotFound(format!("Session not found: {session_id}")));
  }
  Ok(())
}

pub async fn set_session_status(
  pool: &SqlitePool,
  session_id: &str,
  status: &str,
) -> Result<(), DbError> {
  let result = sqlx::query(
    "UPDATE sessions
     SET status = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?",
  )
  .bind(status)
  .bind(session_id)
  .execute(pool)
  .await?;
  if result.rows_affected() == 0 {
    return Err(DbError::NotFound(format!("Session not found: {session_id}")));
  }
  Ok(())
}

pub async fn set_session_model(
  pool: &SqlitePool,
  session_id: &str,
  model: Option<&str>,
) -> Result<(), DbError> {
  let result = sqlx::query(
    "UPDATE sessions
     SET model = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?",
  )
  .bind(model)
  .bind(session_id)
  .execute(pool)
  .await?;
  if result.rows_affected() == 0 {
    return Err(DbError::NotFound(format!("Session not found: {session_id}")));
  }
  Ok(())
}

pub async fn set_session_codex_id(
  pool: &SqlitePool,
  session_id: &str,
  thread_id: &str,
) -> Result<(), DbError> {
  let result = sqlx::query(
    "UPDATE sessions
     SET codex_session_id = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?",
  )
  .bind(thread_id)
  .bind(session_id)
  .execute(pool)
  .await?;
  if result.rows_affected() == 0 {
    return Err(DbError::NotFound(format!("Session not found: {session_id}")));
  }
  Ok(())
}

pub async fn set_session_claude_id(
  pool: &SqlitePool,
  session_id: &str,
  claude_session_id: &str,
) -> Result<(), DbError> {
  let result = sqlx::query(
    "UPDATE sessions
     SET claude_session_id = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?",
  )
  .bind(claude_session_id)
  .bind(session_id)
  .execute(pool)
  .await?;
  if result.rows_affected() == 0 {
    return Err(DbError::NotFound(format!("Session not found: {session_id}")));
  }
  Ok(())
}

pub async fn list_session_messages(
  pool: &SqlitePool,
  session_id: &str,
) -> Result<Vec<SessionMessageRecord>, DbError> {
  let rows = sqlx::query_as::<_, SessionMessageRecord>(
    "SELECT id, session_id, turn_id, role, content, sent_at, cancelled_at, metadata_json, checkpoint_id
     FROM session_messages
     WHERE session_id = ?
     ORDER BY created_at ASC",
  )
  .bind(session_id)
  .fetch_all(pool)
  .await?;
  Ok(rows)
}

#[allow(dead_code)]
pub async fn insert_session_message_with_next_turn(
  pool: &SqlitePool,
  message: NewSessionMessageDraft,
) -> Result<SessionMessageRecord, DbError> {
  let mut tx = pool.begin().await?;
  let next: i64 = sqlx::query_scalar(
    "SELECT COALESCE(MAX(turn_id), 0) + 1 FROM session_messages WHERE session_id = ?",
  )
  .bind(&message.session_id)
  .fetch_one(&mut *tx)
  .await?;
  sqlx::query(
    "INSERT INTO session_messages
      (id, session_id, turn_id, role, content, sent_at, metadata_json, checkpoint_id)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)",
  )
  .bind(&message.id)
  .bind(&message.session_id)
  .bind(next)
  .bind(&message.role)
  .bind(&message.content)
  .bind(&message.metadata_json)
  .bind(&message.checkpoint_id)
  .execute(&mut *tx)
  .await?;
  tx.commit().await?;

  get_session_message(pool, &message.id).await
}

pub async fn insert_session_message(
  pool: &SqlitePool,
  message: NewSessionMessage,
) -> Result<SessionMessageRecord, DbError> {
  sqlx::query(
    "INSERT INTO session_messages
      (id, session_id, turn_id, role, content, sent_at, metadata_json, checkpoint_id)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)",
  )
  .bind(&message.id)
  .bind(&message.session_id)
  .bind(message.turn_id)
  .bind(&message.role)
  .bind(&message.content)
  .bind(&message.metadata_json)
  .bind(&message.checkpoint_id)
  .execute(pool)
  .await?;

  get_session_message(pool, &message.id).await
}

pub async fn update_session_message_content(
  pool: &SqlitePool,
  message_id: &str,
  content: &str,
  metadata_json: Option<&str>,
) -> Result<(), DbError> {
  let result = sqlx::query(
    "UPDATE session_messages
     SET content = ?, metadata_json = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?",
  )
  .bind(content)
  .bind(metadata_json)
  .bind(message_id)
  .execute(pool)
  .await?;
  if result.rows_affected() == 0 {
    return Err(DbError::NotFound(format!(
      "Session message not found: {message_id}"
    )));
  }
  Ok(())
}

#[allow(dead_code)]
pub async fn set_session_message_cancelled(
  pool: &SqlitePool,
  message_id: &str,
) -> Result<(), DbError> {
  // TODO: Wire this into cancel flow once we track the active assistant message id.
  let result = sqlx::query(
    "UPDATE session_messages
     SET cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?",
  )
  .bind(message_id)
  .execute(pool)
  .await?;
  if result.rows_affected() == 0 {
    return Err(DbError::NotFound(format!(
      "Session message not found: {message_id}"
    )));
  }
  Ok(())
}

pub async fn generate_message_id(pool: &SqlitePool) -> Result<String, DbError> {
  generate_random_id(pool).await
}

async fn get_session_message(
  pool: &SqlitePool,
  message_id: &str,
) -> Result<SessionMessageRecord, DbError> {
  let row = sqlx::query_as::<_, SessionMessageRecord>(
    "SELECT id, session_id, turn_id, role, content, sent_at, cancelled_at, metadata_json, checkpoint_id
     FROM session_messages
     WHERE id = ?",
  )
  .bind(message_id)
  .fetch_optional(pool)
  .await?;
  row.ok_or_else(|| DbError::NotFound(format!("Session message not found: {message_id}")))
}

pub async fn count_workspace_sessions(
  pool: &SqlitePool,
  workspace_id: &str,
) -> Result<i64, DbError> {
  let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE workspace_id = ?")
    .bind(workspace_id)
    .fetch_one(pool)
    .await?;
  Ok(count)
}

pub async fn next_turn_id(
  pool: &SqlitePool,
  session_id: &str,
) -> Result<i64, DbError> {
  let next: i64 = sqlx::query_scalar(
    "SELECT COALESCE(MAX(turn_id), 0) + 1 FROM session_messages WHERE session_id = ?",
  )
  .bind(session_id)
  .fetch_one(pool)
  .await?;
  Ok(next)
}

pub async fn get_session_message_checkpoint(
  pool: &SqlitePool,
  session_id: &str,
  turn_id: i64,
) -> Result<Option<SessionMessageCheckpoint>, DbError> {
  let row = sqlx::query_as::<_, SessionMessageCheckpoint>(
    "SELECT checkpoint_id, role
     FROM session_messages
     WHERE session_id = ? AND turn_id = ?",
  )
  .bind(session_id)
  .bind(turn_id)
  .fetch_optional(pool)
  .await?;
  Ok(row)
}

pub async fn delete_session_messages_from_turn(
  pool: &SqlitePool,
  session_id: &str,
  turn_id: i64,
) -> Result<(), DbError> {
  let mut tx = pool.begin().await?;
  sqlx::query(
    "DELETE FROM attachments
     WHERE session_message_id IN (
       SELECT id FROM session_messages WHERE session_id = ? AND turn_id >= ?
     )",
  )
  .bind(session_id)
  .bind(turn_id)
  .execute(&mut *tx)
  .await?;
  sqlx::query("DELETE FROM session_messages WHERE session_id = ? AND turn_id >= ?")
    .bind(session_id)
    .bind(turn_id)
    .execute(&mut *tx)
    .await?;
  tx.commit().await?;
  Ok(())
}

pub async fn list_workspace_sessions(
  pool: &SqlitePool,
  workspace_id: &str,
) -> Result<Vec<SessionRecord>, DbError> {
  let rows = sqlx::query_as::<_, SessionRecord>(
    "SELECT id, workspace_id, title, agent_type, model, status, unread_count,
            claude_session_id, codex_session_id, context_token_count, is_compacted
     FROM sessions
     WHERE workspace_id = ?
     ORDER BY created_at DESC",
  )
  .bind(workspace_id)
  .fetch_all(pool)
  .await?;
  Ok(rows)
}

pub async fn clear_session_resume(
  pool: &SqlitePool,
  session_id: &str,
) -> Result<(), DbError> {
  let result = sqlx::query(
    "UPDATE sessions
     SET claude_session_id = NULL, codex_session_id = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?",
  )
  .bind(session_id)
  .execute(pool)
  .await?;
  if result.rows_affected() == 0 {
    return Err(DbError::NotFound(format!("Session not found: {session_id}")));
  }
  Ok(())
}

async fn generate_random_id(pool: &SqlitePool) -> Result<String, DbError> {
  let id: String = sqlx::query_scalar("SELECT lower(hex(randomblob(16)))")
    .fetch_one(pool)
    .await?;
  Ok(id)
}
