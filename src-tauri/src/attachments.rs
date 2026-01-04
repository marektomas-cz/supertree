use crate::db::DbError;
use serde::Serialize;
use sqlx::SqlitePool;

#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentRecord {
  pub id: String,
  pub session_id: String,
  pub session_message_id: Option<String>,
  #[serde(rename = "type")]
  pub attachment_type: String,
  pub title: Option<String>,
  pub path: Option<String>,
  pub mime_type: Option<String>,
  pub is_draft: bool,
}

pub struct NewAttachment {
  pub id: String,
  pub session_id: String,
  pub session_message_id: Option<String>,
  pub attachment_type: String,
  pub title: Option<String>,
  pub path: Option<String>,
  pub mime_type: Option<String>,
  pub is_draft: bool,
}

pub async fn generate_attachment_id(pool: &SqlitePool) -> Result<String, DbError> {
  let id: String = sqlx::query_scalar("SELECT lower(hex(randomblob(16)))")
    .fetch_one(pool)
    .await?;
  Ok(id)
}

pub async fn insert_attachment(
  pool: &SqlitePool,
  attachment: NewAttachment,
) -> Result<AttachmentRecord, DbError> {
  sqlx::query(
    "INSERT INTO attachments
      (id, session_id, session_message_id, type, title, path, mime_type, is_draft)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
  .bind(&attachment.id)
  .bind(&attachment.session_id)
  .bind(&attachment.session_message_id)
  .bind(&attachment.attachment_type)
  .bind(&attachment.title)
  .bind(&attachment.path)
  .bind(&attachment.mime_type)
  .bind(attachment.is_draft)
  .execute(pool)
  .await?;
  get_attachment(pool, &attachment.id).await
}

pub async fn get_attachment(
  pool: &SqlitePool,
  attachment_id: &str,
) -> Result<AttachmentRecord, DbError> {
  let row = sqlx::query_as::<_, AttachmentRecord>(
    "SELECT id, session_id, session_message_id, type as attachment_type, title, path, mime_type, is_draft
     FROM attachments
     WHERE id = ?",
  )
  .bind(attachment_id)
  .fetch_optional(pool)
  .await?;
  row.ok_or_else(|| DbError::NotFound(format!("Attachment not found: {attachment_id}")))
}

pub async fn list_session_attachments(
  pool: &SqlitePool,
  session_id: &str,
) -> Result<Vec<AttachmentRecord>, DbError> {
  let rows = sqlx::query_as::<_, AttachmentRecord>(
    "SELECT id, session_id, session_message_id, type as attachment_type, title, path, mime_type, is_draft
     FROM attachments
     WHERE session_id = ?
     ORDER BY created_at ASC",
  )
  .bind(session_id)
  .fetch_all(pool)
  .await?;
  Ok(rows)
}

pub async fn attach_attachments_to_message(
  pool: &SqlitePool,
  session_id: &str,
  message_id: &str,
  attachment_ids: &[String],
) -> Result<(), DbError> {
  for attachment_id in attachment_ids {
    let result = sqlx::query(
      "UPDATE attachments
       SET session_message_id = ?, is_draft = 0, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND session_id = ?",
    )
    .bind(message_id)
    .bind(attachment_id)
    .bind(session_id)
    .execute(pool)
    .await?;
    if result.rows_affected() == 0 {
      return Err(DbError::NotFound(format!(
        "Attachment not found: {attachment_id}"
      )));
    }
  }
  Ok(())
}

pub async fn delete_attachment(pool: &SqlitePool, attachment_id: &str) -> Result<(), DbError> {
  let result = sqlx::query("DELETE FROM attachments WHERE id = ?")
    .bind(attachment_id)
    .execute(pool)
    .await?;
  if result.rows_affected() == 0 {
    return Err(DbError::NotFound(format!(
      "Attachment not found: {attachment_id}"
    )));
  }
  Ok(())
}
