export type SessionRecord = {
  id: string;
  workspaceId: string;
  title?: string | null;
  agentType: 'claude' | 'codex' | 'unknown';
  model?: string | null;
  status: string;
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
  role: string;
  content: string;
  sentAt?: string | null;
  cancelledAt?: string | null;
  metadataJson?: string | null;
};

export type SessionMessageEvent = {
  sessionId: string;
  message: {
    id: string;
    role: string;
    content: string;
    metadata?: unknown;
    streaming: boolean;
  };
};

export type SessionStatusEvent = {
  sessionId: string;
  status: string;
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
