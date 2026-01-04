export const SIDECAR_METHODS = {
  CANCEL: 'cancel',
  CLAUDE_AUTH: 'claudeAuth',
  WORKSPACE_INIT: 'workspaceInit',
  CONTEXT_USAGE: 'contextUsage',
} as const;

export const SIDECAR_NOTIFICATIONS = {
  QUERY: 'query',
  UPDATE_PERMISSION_MODE: 'updatePermissionMode',
} as const;

export const FRONTEND_NOTIFICATIONS = {
  MESSAGE: 'message',
  QUERY_ERROR: 'queryError',
  ENTER_PLAN_MODE: 'enterPlanModeNotification',
} as const;

export const FRONTEND_RPC_METHODS = {
  EXIT_PLAN_MODE: 'exitPlanMode',
  ASK_USER_QUESTION: 'askUserQuestion',
  GET_DIFF: 'getDiff',
} as const;

export type AgentType = 'claude' | 'codex' | 'unknown';

export type QueryOptions = {
  cwd: string;
  model?: string;
  permissionMode?: string;
  turnId?: number;
  resume?: string;
  resumeSessionAt?: string;
  shouldResetGenerator?: boolean;
  claudeEnvVars?: string;
  additionalDirectories?: string[];
  ghToken?: string;
  conductorEnv?: Record<string, string>;
  codexApiKey?: string;
  codexBaseUrl?: string;
  codexModelReasoningEffort?: string;
};

export type QueryRequest = {
  type: 'query';
  id: string;
  agentType: AgentType;
  prompt: string;
  options: QueryOptions;
};

export type CancelRequest = {
  type: 'cancel';
  id: string;
  agentType: AgentType;
};

export type ClaudeAuthRequest = {
  type: 'claude_auth';
  id: string;
  agentType: 'claude';
  options: { cwd: string };
};

export type WorkspaceInitRequest = {
  type: 'workspace_init';
  id: string;
  agentType: 'claude';
  options: { cwd: string; ghToken?: string; claudeEnvVars?: string };
};

export type ContextUsageRequest = {
  type: 'context_usage';
  id: string;
  agentType: 'claude';
  options: { cwd: string; claudeSessionId: string };
};

export type UpdatePermissionModeRequest = {
  type: 'update_permission_mode';
  id: string;
  agentType: 'claude';
  permissionMode: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isString = (value: unknown): value is string => typeof value === 'string';

const isAgentType = (value: unknown): value is AgentType =>
  value === 'claude' || value === 'codex' || value === 'unknown';

export const isQueryRequest = (value: unknown): value is QueryRequest => {
  if (!isRecord(value)) return false;
  if (value.type !== 'query' || !isString(value.id) || !isAgentType(value.agentType)) {
    return false;
  }
  if (!isString(value.prompt)) return false;
  if (!isRecord(value.options)) return false;
  return isString(value.options.cwd);
};

export const isCancelRequest = (value: unknown): value is CancelRequest => {
  if (!isRecord(value)) return false;
  return value.type === 'cancel' && isString(value.id) && isAgentType(value.agentType);
};

export const isClaudeAuthRequest = (value: unknown): value is ClaudeAuthRequest => {
  if (!isRecord(value)) return false;
  if (value.type !== 'claude_auth' || !isString(value.id) || value.agentType !== 'claude') {
    return false;
  }
  if (!isRecord(value.options)) return false;
  return isString(value.options.cwd);
};

export const isWorkspaceInitRequest = (
  value: unknown,
): value is WorkspaceInitRequest => {
  if (!isRecord(value)) return false;
  if (
    value.type !== 'workspace_init' ||
    !isString(value.id) ||
    value.agentType !== 'claude'
  ) {
    return false;
  }
  if (!isRecord(value.options)) return false;
  return isString(value.options.cwd);
};

export const isContextUsageRequest = (
  value: unknown,
): value is ContextUsageRequest => {
  if (!isRecord(value)) return false;
  if (value.type !== 'context_usage' || !isString(value.id) || value.agentType !== 'claude') {
    return false;
  }
  if (!isRecord(value.options)) return false;
  return isString(value.options.cwd) && isString(value.options.claudeSessionId);
};

export const isUpdatePermissionModeRequest = (
  value: unknown,
): value is UpdatePermissionModeRequest => {
  if (!isRecord(value)) return false;
  return (
    value.type === 'update_permission_mode' &&
    isString(value.id) &&
    value.agentType === 'claude' &&
    isString(value.permissionMode)
  );
};
