export type WorkspaceInfo = {
  id: string;
  repoId: string;
  branch: string;
  directoryName?: string | null;
  path: string;
  state: 'active' | 'archived';
  pinnedAt?: string | null;
  unread: boolean;
  basePort?: number | null;
  setupLogPath?: string | null;
  archiveLogPath?: string | null;
};

export type FilePreview = {
  path: string;
  content: string;
  truncated: boolean;
  binary: boolean;
};
