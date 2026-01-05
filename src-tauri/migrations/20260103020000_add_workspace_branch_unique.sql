CREATE UNIQUE INDEX idx_workspaces_repo_branch_state
  ON workspaces (repo_id, branch, state);
