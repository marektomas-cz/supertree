use crate::db::DbError;
use serde::Serialize;
use sqlx::SqlitePool;

/// Settings key for the default chat model.
pub const KEY_DEFAULT_MODEL: &str = "default_model";
/// Settings key for the review model.
pub const KEY_REVIEW_MODEL: &str = "review_model";
/// Settings key for the review thinking level.
pub const KEY_REVIEW_THINKING_LEVEL: &str = "review_thinking_level";
/// Settings key for Claude permission mode.
pub const KEY_CLAUDE_PERMISSION_MODE: &str = "claude_permission_mode";
/// Settings key for raw environment variables text.
pub const KEY_ENV_VARS: &str = "env_vars";
/// Settings key for optional workspaces root override.
pub const KEY_WORKSPACES_ROOT: &str = "workspaces_root";
/// Settings key for spotlight feature enablement.
pub const KEY_SPOTLIGHT_ENABLED: &str = "spotlight_enabled";

const DEFAULT_SETTINGS: &[(&str, &str)] = &[
  (KEY_DEFAULT_MODEL, "gpt-5-codex"),
  (KEY_REVIEW_MODEL, "gpt-5-codex"),
  (KEY_REVIEW_THINKING_LEVEL, "medium"),
  (KEY_CLAUDE_PERMISSION_MODE, "default"),
  (KEY_ENV_VARS, ""),
  (KEY_WORKSPACES_ROOT, ""),
  (KEY_SPOTLIGHT_ENABLED, "false"),
];

/// Stored settings entry.
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct SettingEntry {
  /// Setting key.
  pub key: String,
  /// Setting value.
  pub value: String,
}

/// Ensure the default settings are present on first run.
pub async fn ensure_defaults(pool: &SqlitePool) -> Result<(), DbError> {
  for (key, value) in DEFAULT_SETTINGS {
    sqlx::query(
      "INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO NOTHING",
    )
    .bind(key)
    .bind(value)
    .execute(pool)
    .await?;
  }
  Ok(())
}

/// List all settings entries ordered by key.
pub async fn list_settings(pool: &SqlitePool) -> Result<Vec<SettingEntry>, DbError> {
  let rows = sqlx::query_as::<_, SettingEntry>("SELECT key, value FROM settings ORDER BY key")
    .fetch_all(pool)
    .await?;
  Ok(rows)
}

/// Insert or update a settings value by key.
pub async fn set_setting(pool: &SqlitePool, key: &str, value: &str) -> Result<(), DbError> {
  sqlx::query(
    "INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP",
  )
  .bind(key)
  .bind(value)
  .execute(pool)
  .await?;
  Ok(())
}

/// Fetch a settings value by key.
pub async fn get_setting(pool: &SqlitePool, key: &str) -> Result<Option<String>, DbError> {
  let value = sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?")
    .bind(key)
    .fetch_optional(pool)
    .await?;
  Ok(value)
}

/// Get the raw env var block stored in settings.
pub async fn get_env_vars(pool: &SqlitePool) -> Result<String, DbError> {
  Ok(get_setting(pool, KEY_ENV_VARS).await?.unwrap_or_default())
}

/// Persist the raw env var block in settings.
pub async fn set_env_vars(pool: &SqlitePool, value: &str) -> Result<(), DbError> {
  set_setting(pool, KEY_ENV_VARS, value).await
}
