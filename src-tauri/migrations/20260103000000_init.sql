CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  remote_url TEXT,
  default_branch TEXT,
  scripts_setup TEXT,
  scripts_run TEXT,
  scripts_archive TEXT,
  run_script_mode TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  directory_name TEXT,
  path TEXT NOT NULL,
  state TEXT NOT NULL,
  pinned_at TEXT,
  unread INTEGER NOT NULL DEFAULT 0,
  initialization_log_path TEXT,
  setup_log_path TEXT,
  initialization_files_copied INTEGER,
  intended_target_branch TEXT,
  placeholder_branch_name TEXT,
  linked_workspace_ids TEXT,
  big_terminal_mode INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT,
  agent_type TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL,
  unread_count INTEGER NOT NULL DEFAULT 0,
  claude_session_id TEXT,
  codex_session_id TEXT,
  is_compacted INTEGER NOT NULL DEFAULT 0,
  context_token_count INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS session_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  sent_at TEXT,
  cancelled_at TEXT,
  last_assistant_message_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  session_message_id TEXT,
  type TEXT NOT NULL,
  title TEXT,
  path TEXT,
  mime_type TEXT,
  is_draft INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (session_message_id) REFERENCES session_messages(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_sessions_workspace_id ON sessions(workspace_id);
CREATE INDEX idx_session_messages_session_id ON session_messages(session_id);
CREATE INDEX idx_session_messages_sent_at ON session_messages(sent_at);
CREATE INDEX idx_attachments_session_id ON attachments(session_id);
CREATE INDEX idx_attachments_session_message_id ON attachments(session_message_id);
