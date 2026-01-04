export type SessionStatus = 'idle' | 'running' | 'error';

export type SessionRole = 'user' | 'assistant' | 'system';

export type SessionRecord = {
  id: string;
  workspaceId: string;
  title?: string | null;
  agentType: 'claude' | 'codex' | 'unknown';
  model?: string | null;
  status: SessionStatus;
  unreadCount: number;
  claudeSessionId?: string | null;
  codexSessionId?: string | null;
  contextTokenCount?: number | null;
  isCompacted: boolean;
};

export type SessionMessageRecord = {
  id: string;
  sessionId: string;
  turnId: number;
  role: SessionRole;
  content: string;
  sentAt?: string | null;
  cancelledAt?: string | null;
  metadataJson?: string | null;
};

export type SessionMessageEvent = {
  sessionId: string;
  message: {
    id: string;
    role: SessionRole;
    content: string;
    metadata?: unknown;
    streaming: boolean;
  };
};

export type SessionStatusEvent = {
  sessionId: string;
  status: SessionStatus;
};

export type SessionErrorEvent = {
  sessionId: string;
  error: string;
};

export type SessionPlanModeEvent = {
  sessionId: string;
};

export type AskUserQuestionEvent = {
  requestId: string;
  sessionId: string;
  questions: Array<{ question: string; options: string[] }>;
};

export type ExitPlanModeEvent = {
  requestId: string;
  sessionId: string;
};

export type AttachmentRecord = {
  id: string;
  sessionId: string;
  sessionMessageId?: string | null;
  type: string;
  title?: string | null;
  path?: string | null;
  mimeType?: string | null;
  isDraft: boolean;
};
