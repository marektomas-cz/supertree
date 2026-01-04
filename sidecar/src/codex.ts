import { Codex, type ThreadEvent, type ThreadItem, type ThreadStartedEvent, type ModelReasoningEffort } from '@openai/codex-sdk';
import type { AgentType, FrontendApiBase, QueryOptions } from './protocol.js';
import { resolveCodexBinaryPath } from './utils.js';

export type FrontendApi = FrontendApiBase;

type CodexSessionState = {
  threadId?: string;
  controller?: AbortController;
  lastTextByItem: Map<string, string>;
  toolSummary: Record<string, number>;
};

const TOOL_ITEM_TYPES = ['mcp_tool_call'] as const;
type ToolItemType = (typeof TOOL_ITEM_TYPES)[number];
const isToolItemType = (value: string): value is ToolItemType =>
  (TOOL_ITEM_TYPES as readonly string[]).includes(value);

const isAbortError = (error: unknown) => {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes('abort');
};

const extractCodexTextDelta = (
  event: ThreadEvent,
  state: CodexSessionState,
): { delta?: string; isFinal?: boolean; toolSummary?: Record<string, number> } => {
  if (event.type === 'item.updated' || event.type === 'item.started' || event.type === 'item.completed') {
    const item = event.item as ThreadItem;
    if (item.type === 'agent_message') {
      const previous = state.lastTextByItem.get(item.id) ?? '';
      const nextText = item.text ?? '';
      state.lastTextByItem.set(item.id, nextText);
      if (nextText.startsWith(previous)) {
        return { delta: nextText.slice(previous.length) };
      }
      return { delta: nextText };
    }
    if (event.type === 'item.completed' && isToolItemType(item.type)) {
      state.toolSummary[item.type] = (state.toolSummary[item.type] ?? 0) + 1;
      return { toolSummary: state.toolSummary };
    }
    return {};
  }
  if (event.type === 'turn.completed' || event.type === 'turn.failed') {
    return { isFinal: true, toolSummary: state.toolSummary };
  }
  if (event.type === 'error') {
    return { isFinal: true };
  }
  return {};
};

export class CodexSessionManager {
  private readonly sessions = new Map<string, CodexSessionState>();

  async handleQuery(sessionId: string, prompt: string, options: QueryOptions, frontend: FrontendApi) {
    const state = this.sessions.get(sessionId) ?? {
      lastTextByItem: new Map(),
      toolSummary: {},
    };
    this.sessions.set(sessionId, state);
    state.lastTextByItem.clear();
    state.toolSummary = {};
    if (options.resume && options.resume !== state.threadId) {
      state.threadId = options.resume;
    }

    const controller = new AbortController();
    state.controller = controller;

    const envForCodex: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') {
        envForCodex[key] = value;
      }
    }
    if (options.conductorEnv) {
      for (const [key, value] of Object.entries(options.conductorEnv)) {
        if (value === '') {
          delete envForCodex[key];
        } else {
          envForCodex[key] = value;
        }
      }
    }
    if (options.ghToken) {
      envForCodex.GH_TOKEN = options.ghToken;
    }

    const codex = new Codex({
      codexPathOverride: resolveCodexBinaryPath(),
      env: envForCodex,
      apiKey: options.codexApiKey,
      baseUrl: options.codexBaseUrl,
    });

    const threadOptions = {
      // SECURITY: Codex runs in a trusted local sidecar context with explicit user intent.
      // Keep these permissive settings scoped to local/dev; revisit if deploying to shared hosts.
      sandboxMode: 'danger-full-access',
      workingDirectory: options.cwd,
      skipGitRepoCheck: true,
      webSearchEnabled: true,
      networkAccessEnabled: true,
      approvalPolicy: 'never',
      model: options.model,
      modelReasoningEffort: options.codexModelReasoningEffort as ModelReasoningEffort | undefined,
    };

    const thread = state.threadId
      ? codex.resumeThread(state.threadId, threadOptions)
      : codex.startThread(threadOptions);

    try {
      const streamed = await thread.runStreamed(prompt, { signal: controller.signal });
      for await (const event of streamed.events) {
        if (event.type === 'thread.started') {
          const started = event as ThreadStartedEvent;
          state.threadId = started.thread_id;
        }
        const { delta, isFinal, toolSummary } = extractCodexTextDelta(event, state);
        frontend.sendMessage({
          id: sessionId,
          type: 'message',
          agentType: 'codex' satisfies AgentType,
          data: event,
          textDelta: delta,
          isFinal,
          toolSummary,
          threadId: state.threadId,
        });
      }
    } catch (error) {
      if (!isAbortError(error)) {
        frontend.sendError({
          id: sessionId,
          type: 'error',
          agentType: 'codex' satisfies AgentType,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      state.controller = undefined;
    }
  }

  handleCancel(sessionId: string, frontend: FrontendApi) {
    const state = this.sessions.get(sessionId);
    if (!state?.controller) {
      return;
    }
    state.controller.abort();
    frontend.sendError({
      id: sessionId,
      type: 'error',
      error: 'aborted by user',
      agentType: 'codex' satisfies AgentType,
    });
  }
}
