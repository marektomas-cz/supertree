ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS setup_log_path TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS archive_log_path TEXT;
