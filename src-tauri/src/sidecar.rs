use crate::db::Database;
use crate::path_utils;
use crate::sessions;
use crate::workspace;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::env;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri::path::BaseDirectory;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::sync::{Mutex, oneshot};
use tokio::task::JoinHandle;
use tokio::time::timeout;

type SidecarWriter = Box<dyn tokio::io::AsyncWrite + Send + Unpin>;
type PendingResponse = oneshot::Sender<Result<Value, String>>;
const SOCKET_PATH_TIMEOUT_SECS: u64 = 30;
const FRONTEND_RESPONSE_TIMEOUT_SECS: u64 = 120;
const MAX_STORED_DIFF_BYTES: usize = 200_000;

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
  if value.len() <= max_bytes {
    return value.to_string();
  }
  let mut end = 0;
  for (idx, ch) in value.char_indices() {
    let next = idx + ch.len_utf8();
    if next > max_bytes {
      break;
    }
    end = next;
  }
  value[..end].to_string()
}

#[derive(Clone)]
pub struct SidecarManager {
  sessions: Arc<Mutex<HashMap<String, Arc<SidecarSession>>>>,
  pending_frontend: Arc<Mutex<HashMap<String, PendingFrontendRequest>>>,
  app_handle: AppHandle,
  db: Database,
}

struct PendingFrontendRequest {
  responder: oneshot::Sender<Value>,
}

struct SidecarSession {
  session_id: String,
  writer: Arc<Mutex<SidecarWriter>>,
  pending: Arc<Mutex<HashMap<String, PendingResponse>>>,
  streaming: Arc<Mutex<StreamingState>>,
  child: Arc<Mutex<Option<Child>>>,
  closing: Arc<AtomicBool>,
  reader_task: Arc<Mutex<Option<JoinHandle<()>>>>,
}

#[derive(Default)]
struct StreamingState {
  current_turn_id: Option<i64>,
  assistant_message_id: Option<String>,
  assistant_content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsonRpcRequest {
  id: Value,
  method: String,
  params: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsonRpcNotification {
  method: String,
  params: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsonRpcResponse {
  id: Value,
  result: Option<Value>,
  error: Option<JsonRpcError>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsonRpcError {
  message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarMessagePayload {
  id: String,
  #[serde(rename = "type")]
  kind: String,
  agent_type: String,
  data: Value,
  text_delta: Option<String>,
  text: Option<String>,
  is_final: Option<bool>,
  tool_summary: Option<Value>,
  thread_id: Option<String>,
  agent_session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarErrorPayload {
  id: String,
  #[serde(rename = "type")]
  kind: String,
  agent_type: String,
  error: String,
  data: Option<Value>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AskUserQuestionPayload {
  session_id: String,
  questions: Vec<UserQuestion>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UserQuestion {
  question: String,
  options: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExitPlanModePayload {
  session_id: String,
  tool_input: Value,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GetDiffPayload {
  session_id: String,
  file: Option<String>,
  stat: Option<bool>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SessionMessageEvent {
  session_id: String,
  message: UiMessagePayload,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UiMessagePayload {
  id: String,
  role: String,
  content: String,
  metadata: Option<Value>,
  streaming: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SessionErrorEvent {
  session_id: String,
  error: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SessionStatusEvent {
  session_id: String,
  status: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SessionPlanModeEvent {
  session_id: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AskUserQuestionEvent {
  request_id: String,
  session_id: String,
  questions: Vec<UserQuestion>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExitPlanModeEvent {
  request_id: String,
  session_id: String,
}

impl SidecarManager {
  pub fn new(app_handle: AppHandle, db: Database) -> Self {
    Self {
      sessions: Arc::new(Mutex::new(HashMap::new())),
      pending_frontend: Arc::new(Mutex::new(HashMap::new())),
      app_handle,
      db,
    }
  }

  pub async fn send_query(
    &self,
    session_id: &str,
    agent_type: &str,
    prompt: &str,
    options: Value,
    turn_id: i64,
  ) -> Result<(), String> {
    if !matches!(agent_type, "claude" | "codex") {
      return Err(format!("Unknown agent type: {agent_type}"));
    }
    let session = self.ensure_session(session_id).await?;
    {
      let mut state = session.streaming.lock().await;
      state.current_turn_id = Some(turn_id);
      state.assistant_message_id = None;
      state.assistant_content.clear();
    }
    let payload = json!({
      "jsonrpc": "2.0",
      "method": "query",
      "params": {
        "type": "query",
        "id": session_id,
        "agentType": agent_type,
        "prompt": prompt,
        "options": options,
      }
    });
    session.send_raw(payload).await
  }

  pub async fn cancel(&self, session_id: &str, agent_type: &str) -> Result<(), String> {
    let session = self.ensure_session(session_id).await?;
    let payload = json!({
      "jsonrpc": "2.0",
      "method": "cancel",
      "params": {
        "type": "cancel",
        "id": session_id,
        "agentType": agent_type,
      }
    });
    session.send_raw(payload).await
  }

  pub async fn update_permission_mode(
    &self,
    session_id: &str,
    agent_type: &str,
    mode: &str,
  ) -> Result<(), String> {
    if !matches!(agent_type, "claude" | "codex") {
      return Err(format!("Unknown agent type: {agent_type}"));
    }
    let session = self.ensure_session(session_id).await?;
    let payload = json!({
      "jsonrpc": "2.0",
      "method": "updatePermissionMode",
      "params": {
        "type": "update_permission_mode",
        "id": session_id,
        "agentType": agent_type,
        "permissionMode": mode,
      }
    });
    session.send_raw(payload).await
  }

  pub async fn resolve_frontend_request(
    &self,
    request_id: &str,
    payload: Value,
  ) -> Result<(), String> {
    let mut pending = self
      .pending_frontend
      .lock()
      .await;
    let Some(entry) = pending.remove(request_id) else {
      return Err(format!("Frontend request not found: {request_id}"));
    };
    entry
      .responder
      .send(payload)
      .map_err(|_| "Failed to deliver frontend response".to_string())
  }

  pub async fn close_session(&self, session_id: &str) {
    let session = {
      let mut guard = self.sessions.lock().await;
      guard.remove(session_id)
    };
    if let Some(session) = session {
      session.shutdown().await;
    }
  }

  pub async fn shutdown_all(&self) {
    let sessions = {
      let guard = self.sessions.lock().await;
      guard.values().cloned().collect::<Vec<_>>()
    };
    for session in sessions {
      session.shutdown().await;
    }
  }

  async fn ensure_session(&self, session_id: &str) -> Result<Arc<SidecarSession>, String> {
    let existing = {
      let guard = self.sessions.lock().await;
      guard.get(session_id).cloned()
    };
    if let Some(session) = existing {
      return Ok(session);
    }
    let session = self.spawn_session(session_id).await?;
    let mut guard = self.sessions.lock().await;
    guard.insert(session_id.to_string(), session.clone());
    Ok(session)
  }

  async fn spawn_session(&self, session_id: &str) -> Result<Arc<SidecarSession>, String> {
    // NOTE: One Node sidecar process + socket reader per session for isolation.
    // Per session: one child process, one socket connection, and stdio FDs (~4-6 total).
    // Memory is dominated by the Node runtime + SDK (rough order: tens of MB per session).
    // No pooling/limit yet; keep session counts bounded (TODO: pool/max sessions if needed).
    let (child, socket_path) = spawn_sidecar_process(&self.app_handle)?;
    let (reader, writer) = connect_socket(&socket_path).await?;
    let session = Arc::new(SidecarSession {
      session_id: session_id.to_string(),
      writer: Arc::new(Mutex::new(writer)),
      pending: Arc::new(Mutex::new(HashMap::new())),
      streaming: Arc::new(Mutex::new(StreamingState::default())),
      child: Arc::new(Mutex::new(Some(child))),
      closing: Arc::new(AtomicBool::new(false)),
      reader_task: Arc::new(Mutex::new(None)),
    });
    let reader_handle = self.spawn_reader(session.clone(), reader);
    *session.reader_task.lock().await = Some(reader_handle);
    Ok(session)
  }

  fn spawn_reader(
    &self,
    session: Arc<SidecarSession>,
    reader: Box<dyn tokio::io::AsyncRead + Send + Unpin>,
  ) -> JoinHandle<()> {
    let app_handle = self.app_handle.clone();
    let db = self.db.clone();
    let pending_frontend = self.pending_frontend.clone();
    let sessions_map = self.sessions.clone();
    tokio::spawn(async move {
      let mut lines = tokio::io::BufReader::new(reader).lines();
      loop {
        let line = match lines.next_line().await {
          Ok(Some(value)) => value,
          Ok(None) => break,
          Err(err) => {
            eprintln!("[sidecar] socket read error: {err}");
            break;
          }
        };
        if line.trim().is_empty() {
          continue;
        }
        let payload: Value = match serde_json::from_str(&line) {
          Ok(value) => value,
          Err(err) => {
            eprintln!("[sidecar] failed to parse payload: {err}");
            continue;
          }
        };
        if let Err(err) = handle_payload(
          &session,
          &payload,
          &app_handle,
          &db,
          &pending_frontend,
        )
        .await
        {
          eprintln!("[sidecar] payload handling error: {err}");
        }
      }
      let closing = session.closing.load(Ordering::SeqCst);
      sessions_map.lock().await.remove(&session.session_id);
      if closing {
        let _ = sessions::set_session_status(db.pool(), &session.session_id, "idle").await;
        let _ = app_handle.emit(
          "session-status",
          SessionStatusEvent {
            session_id: session.session_id.clone(),
            status: "idle".to_string(),
          },
        );
      } else {
        let _ = sessions::set_session_status(db.pool(), &session.session_id, "error").await;
        let _ = app_handle.emit(
          "session-error",
          SessionErrorEvent {
            session_id: session.session_id.clone(),
            error: "Sidecar disconnected".to_string(),
          },
        );
      }
    })
  }
}

impl SidecarSession {
  async fn send_raw(&self, payload: Value) -> Result<(), String> {
    let line = serde_json::to_string(&payload).map_err(|err| err.to_string())?;
    let mut writer = self.writer.lock().await;
    writer
      .write_all(line.as_bytes())
      .await
      .map_err(|err| err.to_string())?;
    writer
      .write_all(b"\n")
      .await
      .map_err(|err| err.to_string())?;
    writer.flush().await.map_err(|err| err.to_string())
  }

  async fn send_response(&self, id: Value, result: Value) -> Result<(), String> {
    let payload = json!({
      "jsonrpc": "2.0",
      "id": id,
      "result": result,
    });
    self.send_raw(payload).await
  }

  async fn send_error(&self, id: Value, message: &str) -> Result<(), String> {
    let payload = json!({
      "jsonrpc": "2.0",
      "id": id,
      "error": {
        "code": -32000,
        "message": message,
      }
    });
    self.send_raw(payload).await
  }

  async fn shutdown(&self) {
    self.closing.store(true, Ordering::SeqCst);
    let child = {
      let mut guard = self.child.lock().await;
      guard.take()
    };
    if let Some(mut child) = child {
      if let Err(err) = child.kill() {
        eprintln!("[sidecar] failed to kill process: {err}");
      } else if let Err(err) = child.wait() {
        eprintln!("[sidecar] failed to wait for process: {err}");
      }
    }
    let reader_handle = {
      let mut guard = self.reader_task.lock().await;
      guard.take()
    };
    if let Some(handle) = reader_handle {
      match timeout(Duration::from_secs(2), handle).await {
        Ok(Ok(())) => {}
        Ok(Err(err)) => eprintln!("[sidecar] reader task failed: {err}"),
        Err(_) => eprintln!("[sidecar] reader task shutdown timed out"),
      }
    }
  }
}

async fn handle_payload(
  session: &SidecarSession,
  payload: &Value,
  app_handle: &AppHandle,
  db: &Database,
  pending_frontend: &Arc<Mutex<HashMap<String, PendingFrontendRequest>>>,
) -> Result<(), String> {
  if payload.get("method").is_some() {
    if payload.get("id").is_some() {
      let request: JsonRpcRequest = serde_json::from_value(payload.clone())
        .map_err(|err| err.to_string())?;
      return handle_request(session, request, app_handle, db, pending_frontend).await;
    }
    let notification: JsonRpcNotification = serde_json::from_value(payload.clone())
      .map_err(|err| err.to_string())?;
    return handle_notification(session, notification, app_handle, db).await;
  }
  if payload.get("id").is_some() {
    let response: JsonRpcResponse = serde_json::from_value(payload.clone())
      .map_err(|err| err.to_string())?;
    return handle_response(session, response).await;
  }
  Ok(())
}

async fn handle_response(session: &SidecarSession, response: JsonRpcResponse) -> Result<(), String> {
  let key = id_to_key(&response.id);
  let mut pending = session.pending.lock().await;
  let Some(sender) = pending.remove(&key) else {
    return Ok(());
  };
  if let Some(error) = response.error {
    let _ = sender.send(Err(error.message));
  } else {
    let _ = sender.send(Ok(response.result.unwrap_or(Value::Null)));
  }
  Ok(())
}

async fn handle_notification(
  session: &SidecarSession,
  notification: JsonRpcNotification,
  app_handle: &AppHandle,
  db: &Database,
) -> Result<(), String> {
  match notification.method.as_str() {
    "message" => {
      let params = notification.params.unwrap_or(Value::Null);
      let payload: SidecarMessagePayload = serde_json::from_value(params)
        .map_err(|err| err.to_string())?;
      handle_sidecar_message(session, payload, app_handle, db).await?;
    }
    "queryError" => {
      let params = notification.params.unwrap_or(Value::Null);
      let payload: SidecarErrorPayload = serde_json::from_value(params)
        .map_err(|err| err.to_string())?;
      handle_sidecar_error(session, payload, app_handle, db).await?;
    }
    "enterPlanModeNotification" => {
      let _ = app_handle.emit(
        "session-plan-mode",
        SessionPlanModeEvent {
          session_id: session.session_id.clone(),
        },
      );
    }
    _ => {}
  }
  Ok(())
}

async fn handle_request(
  session: &SidecarSession,
  request: JsonRpcRequest,
  app_handle: &AppHandle,
  db: &Database,
  pending_frontend: &Arc<Mutex<HashMap<String, PendingFrontendRequest>>>,
) -> Result<(), String> {
  match request.method.as_str() {
    "askUserQuestion" => {
      let params = request.params.unwrap_or(Value::Null);
      let payload: AskUserQuestionPayload = serde_json::from_value(params)
        .map_err(|err| err.to_string())?;
      let response = wait_for_frontend(
        pending_frontend,
        app_handle,
        AskUserQuestionEvent {
          request_id: id_to_key(&request.id),
          session_id: payload.session_id,
          questions: payload.questions,
        },
      )
      .await?;
      session.send_response(request.id, response).await?;
    }
    "exitPlanMode" => {
      let params = request.params.unwrap_or(Value::Null);
      let payload: ExitPlanModePayload = serde_json::from_value(params)
        .map_err(|err| err.to_string())?;
      let response = wait_for_frontend(
        pending_frontend,
        app_handle,
        ExitPlanModeEvent {
          request_id: id_to_key(&request.id),
          session_id: payload.session_id,
        },
      )
      .await?;
      session.send_response(request.id, response).await?;
    }
    "getDiff" => {
      let params = request.params.unwrap_or(Value::Null);
      let payload: GetDiffPayload = serde_json::from_value(params)
        .map_err(|err| err.to_string())?;
      let response = get_diff_response(db, &payload).await?;
      session.send_response(request.id, response).await?;
    }
    _ => {
      session
        .send_error(request.id, "Unknown request method")
        .await?;
    }
  }
  Ok(())
}

async fn wait_for_frontend<T: Serialize + Clone>(
  pending_frontend: &Arc<Mutex<HashMap<String, PendingFrontendRequest>>>,
  app_handle: &AppHandle,
  event: T,
) -> Result<Value, String> {
  let (tx, rx) = oneshot::channel();
  let request_id = match serde_json::to_value(&event) {
    Ok(value) => value
      .get("requestId")
      .and_then(|value| value.as_str())
      .map(|value| value.to_string())
      .ok_or_else(|| "Missing requestId".to_string())?,
    Err(err) => return Err(err.to_string()),
  };
  {
    let mut pending = pending_frontend.lock().await;
    pending.insert(
      request_id.clone(),
      PendingFrontendRequest {
        responder: tx,
      },
    );
  }
  app_handle
    .emit("session-request", event)
    .map_err(|err| err.to_string())?;
  let response = match timeout(Duration::from_secs(FRONTEND_RESPONSE_TIMEOUT_SECS), rx).await {
    Ok(result) => result.map_err(|_| "Frontend response dropped".to_string())?,
    Err(_) => {
      let mut pending = pending_frontend.lock().await;
      pending.remove(&request_id);
      return Err("Frontend response timeout".to_string());
    }
  };
  Ok(response)
}

async fn handle_sidecar_message(
  session: &SidecarSession,
  payload: SidecarMessagePayload,
  app_handle: &AppHandle,
  db: &Database,
) -> Result<(), String> {
  if payload.kind != "message" {
    return Ok(());
  }
  if let Some(thread_id) = payload.thread_id.as_deref() {
    let _ = sessions::set_session_codex_id(db.pool(), &payload.id, thread_id).await;
  }
  if let Some(claude_id) = payload.agent_session_id.as_deref() {
    let _ = sessions::set_session_claude_id(db.pool(), &payload.id, claude_id).await;
  }

  let mut stream_state = session.streaming.lock().await;
  let Some(turn_id) = stream_state.current_turn_id else {
    return Ok(());
  };

  let content = if let Some(full) = payload.text.clone() {
    full
  } else if let Some(delta) = payload.text_delta.clone() {
    stream_state.assistant_content.push_str(&delta);
    stream_state.assistant_content.clone()
  } else {
    stream_state.assistant_content.clone()
  };
  if payload.text.is_some() {
    stream_state.assistant_content = content.clone();
  }
  if content.trim().is_empty() {
    if payload.is_final.unwrap_or(false) {
      mark_session_idle(db, app_handle, &payload.id).await;
    }
    return Ok(());
  }

  let mut metadata = json!({
    "agentType": payload.agent_type,
    "raw": payload.data,
    "toolSummary": payload.tool_summary,
  });
  if payload.is_final.unwrap_or(false) {
    if let Some(diff_stat) = get_workspace_diff_stat(db, &payload.id).await {
      if let Some(object) = metadata.as_object_mut() {
        object.insert("diffStat".to_string(), Value::String(diff_stat));
      }
    }
    if payload.agent_type == "claude" {
      let diff_payload = GetDiffPayload {
        session_id: payload.id.clone(),
        file: None,
        stat: Some(false),
      };
      match get_diff_response(db, &diff_payload).await {
        Ok(value) => {
          if let Some(diff) = value.get("diff").and_then(|diff| diff.as_str()) {
            let trimmed = diff.trim();
            if !trimmed.is_empty() {
              let mut stored = trimmed.to_string();
              if stored.len() > MAX_STORED_DIFF_BYTES {
                stored = truncate_utf8(trimmed, MAX_STORED_DIFF_BYTES);
                stored.push_str("\n...[truncated]");
              }
              if let Some(object) = metadata.as_object_mut() {
                object.insert("diff".to_string(), Value::String(stored));       
              }
            }
          }
        }
        Err(err) => {
          eprintln!("[sidecar] diff capture error: {err}");
        }
      }
    }
  }
  let metadata_str = metadata.to_string();

  let (message_id, inserted) = match stream_state.assistant_message_id.clone() {
    Some(id) => (id, false),
    None => {
      let new_id = sessions::generate_message_id(db.pool()).await.map_err(|err| err.to_string())?;
        sessions::insert_session_message(
          db.pool(),
          sessions::NewSessionMessage {
            id: new_id.clone(),
            session_id: payload.id.clone(),
            turn_id,
            role: "assistant".to_string(),
            content: content.clone(),
            metadata_json: Some(metadata_str.clone()),
            checkpoint_id: None,
          },
        )
        .await
      .map_err(|err| err.to_string())?;
      stream_state.assistant_message_id = Some(new_id.clone());
      (new_id, true)
    }
  };

  if !inserted {
    sessions::update_session_message_content(db.pool(), &message_id, &content, Some(&metadata_str))
      .await
      .map_err(|err| err.to_string())?;
  }

  let streaming = !payload.is_final.unwrap_or(false);
  let _ = app_handle.emit(
    "session-message",
    SessionMessageEvent {
      session_id: payload.id.clone(),
      message: UiMessagePayload {
        id: message_id.clone(),
        role: "assistant".to_string(),
        content: content.clone(),
        metadata: Some(metadata),
        streaming,
      },
    },
  );

  if payload.is_final.unwrap_or(false) {
    mark_session_idle(db, app_handle, &payload.id).await;
    stream_state.current_turn_id = None;
  }

  Ok(())
}

async fn handle_sidecar_error(
  session: &SidecarSession,
  payload: SidecarErrorPayload,
  app_handle: &AppHandle,
  db: &Database,
) -> Result<(), String> {
  let turn_id = {
    let state = session.streaming.lock().await;
    state.current_turn_id.unwrap_or(-1)
  };
  let message_id = sessions::generate_message_id(db.pool())
    .await
    .map_err(|err| err.to_string())?;
  let metadata = json!({
    "kind": payload.kind,
    "agentType": payload.agent_type,
    "data": payload.data,
  });
  sessions::insert_session_message(
    db.pool(),
    sessions::NewSessionMessage {
      id: message_id.clone(),
      session_id: payload.id.clone(),
      turn_id,
      role: "system".to_string(),
      content: payload.error.clone(),
      metadata_json: Some(metadata.to_string()),
      checkpoint_id: None,
    },
  )
  .await
  .map_err(|err| err.to_string())?;

  let _ = app_handle.emit(
    "session-error",
    SessionErrorEvent {
      session_id: payload.id.clone(),
      error: payload.error.clone(),
    },
  );

  mark_session_idle(db, app_handle, &payload.id).await;
  Ok(())
}

async fn mark_session_idle(db: &Database, app_handle: &AppHandle, session_id: &str) {
  let _ = sessions::set_session_status(db.pool(), session_id, "idle").await;
  let _ = app_handle.emit(
    "session-status",
    SessionStatusEvent {
      session_id: session_id.to_string(),
      status: "idle".to_string(),
    },
  );
}

async fn get_diff_response(db: &Database, payload: &GetDiffPayload) -> Result<Value, String> {
  let session = sessions::get_session(db.pool(), &payload.session_id)
    .await
    .map_err(|err| err.to_string())?;
  let workspace_record = workspace::get_workspace(db.pool(), &session.workspace_id)
    .await
    .map_err(|err| err.to_string())?;
  let workspace_path = PathBuf::from(workspace_record.path);

  let file = payload.file.clone();
  let stat = payload.stat.unwrap_or(false);
  let diff = tokio::task::spawn_blocking(move || {
    let mut command = Command::new("git");
    command.arg("-C").arg(&workspace_path).arg("diff");
    if stat {
      command.arg("--stat");
    }
    if let Some(file) = file.as_ref() {
      let candidate = PathBuf::from(file);
      if candidate.is_absolute() {
        let relative = candidate
          .strip_prefix(&workspace_path)
          .map_err(|_| "File is outside workspace".to_string())?;
        let normalized = path_utils::normalize_relative_path(relative)?;
        command.arg("--").arg(normalized);
      } else {
        let normalized = path_utils::normalize_relative_path(&candidate)?;
        command.arg("--").arg(normalized);
      }
    }
    let output = command.output().map_err(|err| err.to_string())?;
    if !output.status.success() {
      let stderr = String::from_utf8_lossy(&output.stderr).to_string();
      return Err(stderr);
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
  })
  .await
  .map_err(|err| err.to_string())??;

  Ok(json!({ "diff": diff }))
}

async fn get_workspace_diff_stat(db: &Database, session_id: &str) -> Option<String> {
  let payload = GetDiffPayload {
    session_id: session_id.to_string(),
    file: None,
    stat: Some(true),
  };
  match get_diff_response(db, &payload).await {
    Ok(value) => value
      .get("diff")
      .and_then(|diff| diff.as_str())
      .map(|diff| {
        let trimmed = diff.trim();
        if trimmed.is_empty() {
          "No changes".to_string()
        } else {
          trimmed.to_string()
        }
      }),
    Err(err) => {
      eprintln!("[sidecar] diff stat error: {err}");
      None
    }
  }
}

fn id_to_key(id: &Value) -> String {
  match id {
    Value::String(value) => value.clone(),
    Value::Number(value) => value.to_string(),
    _ => id.to_string(),
  }
}

fn resolve_node_binary() -> Result<PathBuf, String> {
  if let Ok(value) = env::var("SUPERTREE_NODE_PATH") {
    let trimmed = value.trim();
    if trimmed.is_empty() {
      return Err("SUPERTREE_NODE_PATH is set but empty".to_string());
    }
    let path = PathBuf::from(trimmed);
    if !path.is_file() {
      return Err(format!(
        "SUPERTREE_NODE_PATH does not point to a file: {}",
        path.display()
      ));
    }
    return Ok(path);
  }
  Ok(PathBuf::from("node"))
}

fn ensure_node_available(node: &PathBuf) -> Result<(), String> {
  let output = Command::new(node)
    .arg("--version")
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .output()
    .map_err(|_| {
      "Node.js runtime not found. Install Node.js 20+ or set SUPERTREE_NODE_PATH."
        .to_string()
    })?;
  if !output.status.success() {
    return Err(
      "Node.js runtime failed to start. Install Node.js 20+ or set SUPERTREE_NODE_PATH."
        .to_string(),
    );
  }
  Ok(())
}

fn spawn_sidecar_process(app_handle: &AppHandle) -> Result<(Child, String), String> {
  let entry = sidecar_entry(app_handle)?;
  let node = resolve_node_binary()?;
  ensure_node_available(&node)?;
  let mut child = Command::new(node)
    .arg(entry)
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .map_err(|err| format!("Failed to spawn sidecar: {err}"))?;

  let stdout = child.stdout.take().ok_or_else(|| "Missing sidecar stdout".to_string())?;
  let stderr = child.stderr.take().ok_or_else(|| "Missing sidecar stderr".to_string())?;

  let (tx, rx) = std::sync::mpsc::channel();

  std::thread::spawn(move || {
    let reader = BufReader::new(stdout);
    for line in reader.lines().flatten() {
      println!("[sidecar] {line}");
      if let Some(path) = line.strip_prefix("SOCKET_PATH=") {
        let _ = tx.send(path.trim().to_string());
      }
    }
  });

  std::thread::spawn(move || {
    let reader = BufReader::new(stderr);
    for line in reader.lines().flatten() {
      eprintln!("[sidecar] {line}");
    }
  });

  let socket_path = rx
    .recv_timeout(Duration::from_secs(SOCKET_PATH_TIMEOUT_SECS))
    .map_err(|_| "Sidecar socket path timeout".to_string())?;

  Ok((child, socket_path))
}

fn sidecar_entry(app_handle: &AppHandle) -> Result<PathBuf, String> {
  let resource_path = app_handle
    .path()
    .resolve("sidecar/dist/index.js", BaseDirectory::Resource)
    .map_err(|err| err.to_string())?;
  if resource_path.exists() {
    return Ok(resource_path);
  }

  let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
  let root = manifest_dir
    .parent()
    .ok_or_else(|| "Missing project root".to_string())?;
  let dev_path = root.join("sidecar").join("dist").join("index.js");
  if dev_path.exists() {
    return Ok(dev_path);
  }
  Err("Sidecar bundle not found. Run `npm run sidecar:build` before launching."
    .to_string())
}

#[cfg(unix)]
async fn connect_socket(
  socket_path: &str,
) -> Result<(Box<dyn tokio::io::AsyncRead + Send + Unpin>, SidecarWriter), String> {
  use tokio::net::UnixStream;
  let stream = UnixStream::connect(socket_path)
    .await
    .map_err(|err| err.to_string())?;
  let (reader, writer) = tokio::io::split(stream);
  Ok((Box::new(reader), Box::new(writer)))
}

#[cfg(windows)]
async fn connect_socket(
  socket_path: &str,
) -> Result<(Box<dyn tokio::io::AsyncRead + Send + Unpin>, SidecarWriter), String> {
  use std::io::ErrorKind;
  use tokio::net::windows::named_pipe::ClientOptions;
  use tokio::time::{sleep, Instant};

  let deadline = Instant::now() + Duration::from_secs(SOCKET_PATH_TIMEOUT_SECS);
  loop {
    let path = socket_path.to_string();
    let attempt = tokio::task::spawn_blocking(move || ClientOptions::new().open(&path))
      .await
      .map_err(|err| err.to_string())?;
    match attempt {
      Ok(client) => {
        let (reader, writer) = tokio::io::split(client);
        return Ok((Box::new(reader), Box::new(writer)));
      }
      Err(err) => {
        let retry = matches!(err.kind(), ErrorKind::NotFound | ErrorKind::WouldBlock)
          || err.raw_os_error() == Some(231);
        if retry && Instant::now() < deadline {
          sleep(Duration::from_millis(200)).await;
          continue;
        }
        return Err(err.to_string());
      }
    }
  }
}
