import { createSdkMcpServer, query, tool, type PermissionMode, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { AgentType, QueryOptions } from './protocol.js';
import { parseEnvString, resolveClaudeCliPath } from './utils.js';

export type FrontendApi = {
  sendMessage: (payload: unknown) => void;
  sendError: (payload: unknown) => void;
  sendEnterPlanMode: (payload: unknown) => void;
  requestExitPlanMode: (payload: { sessionId: string; toolInput: unknown }) => Promise<{
    approved: boolean;
    turnId?: number | null;
  }>;
  requestAskUserQuestion: (payload: {
    sessionId: string;
    questions: Array<{ question: string; options: string[] }>;
  }) => Promise<{ answers: string[] }>;
  requestGetDiff: (payload: { sessionId: string; file?: string; stat?: boolean }) => Promise<{
    diff?: string;
    error?: string;
  }>;
};

type ClaudeSessionState = {
  currentModel?: string;
  currentPermissionMode?: PermissionMode;
  currentSettings: {
    claudeEnvVars?: string;
    additionalDirectories?: string[];
    ghToken?: string;
  };
  query?: Query;
  sendMessage?: (message: string) => void;
  terminate?: () => void;
  streaming?: Promise<void>;
  lastAssistantText: string;
  claudeSessionId?: string;
};

const DEFAULT_PROMPT = { type: 'preset', preset: 'claude_code' } as const;
const DEFAULT_SETTING_SOURCES = ['user', 'project', 'local'] as const;

const normalizePermissionMode = (value?: string): PermissionMode => {
  if (
    value === 'default' ||
    value === 'acceptEdits' ||
    value === 'bypassPermissions' ||
    value === 'plan' ||
    value === 'delegate' ||
    value === 'dontAsk'
  ) {
    return value;
  }
  return 'default';
};

const settingsChanged = (
  previous: ClaudeSessionState['currentSettings'],
  next: ClaudeSessionState['currentSettings'],
) => {
  const oldEnv = previous.claudeEnvVars ?? '';
  const newEnv = next.claudeEnvVars ?? '';
  if (oldEnv !== newEnv) return true;
  const oldDirs = previous.additionalDirectories ?? [];
  const newDirs = next.additionalDirectories ?? [];
  if (oldDirs.length !== newDirs.length) return true;
  return oldDirs.some((dir, index) => dir !== newDirs[index]);
};

const extractClaudeText = (
  message: SDKMessage,
  previousText: string,
): { delta?: string; full?: string; isFinal?: boolean; sessionId?: string } => {
  let sessionId: string | undefined;
  if (message && 'session_id' in message) {
    const candidate = message.session_id;
    if (typeof candidate === 'string') {
      sessionId = candidate;
    }
  }
  if (message.type === 'stream_event') {
    const event = message.event as Record<string, unknown>;
    if (event?.type === 'content_block_delta') {
      const delta = event.delta as Record<string, unknown> | undefined;
      if (delta && typeof delta.text === 'string') {
        return { delta: delta.text, sessionId };
      }
    }
    if (event?.type === 'content_block_start') {
      const block = event.content_block as Record<string, unknown> | undefined;
      if (block && typeof block.text === 'string') {
        return { delta: block.text, sessionId };
      }
    }
    return { sessionId };
  }
  if (message.type === 'assistant') {
    const content = message.message?.content ?? [];
    if (Array.isArray(content)) {
      const text = content
        .map((item) => (item && typeof item === 'object' && 'text' in item ? String(item.text) : ''))
        .filter(Boolean)
        .join('');
      if (text) {
        if (text.startsWith(previousText)) {
          return { delta: text.slice(previousText.length), full: text, sessionId };
        }
        return { full: text, sessionId };
      }
    }
  }
  if (message.type === 'result') {
    return { isFinal: true, sessionId };
  }
  return { sessionId };
};

const buildClaudeEnv = (options: QueryOptions) => {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (options.claudeEnvVars) {
    const parsed = parseEnvString(options.claudeEnvVars);
    for (const [key, value] of Object.entries(parsed)) {
      if (value === '') {
        delete env[key];
      } else {
        env[key] = value;
      }
    }
  }
  if (options.ghToken) {
    env.GH_TOKEN = options.ghToken;
  }
  return env;
};

const createConductorMcpServer = (sessionId: string, frontend: FrontendApi) =>
  createSdkMcpServer({
    name: 'conductor',
    version: '1.0.0',
    tools: [
      tool(
        'AskUserQuestion',
        'Use this tool to ask the user questions. Do not include an "Other" option; it is provided automatically.',
        {
          questions: z
            .array(
              z.object({
                question: z.string().describe('The question to ask the user'),
                options: z.array(z.string()).max(4).describe('Available options for the user'),
              }),
            )
            .max(4),
        },
        async (args) => {
          const { answers } = await frontend.requestAskUserQuestion({
            sessionId,
            questions: args.questions,
          });
          if (answers.length === 1 && answers[0] === 'USER_CANCELLED') {
            return {
              content: [
                {
                  type: 'text',
                  text: 'User cancelled the question. Please continue without this information.',
                },
              ],
            };
          }
          return {
            content: [
              {
                type: 'text',
                text: `User responses:\n${answers
                  .map((answer, index) => `${index + 1}. ${answer}`)
                  .join('\n')}`,
              },
            ],
          };
        },
      ),
      tool(
        'GetWorkspaceDiff',
        'Returns the current workspace diff. Use this when you need a unified diff or diff stats.',
        {
          file: z.string().optional().describe('Absolute path to a file to diff'),
          stat: z.boolean().optional().describe('Return git diff --stat instead of full diff'),
        },
        async (args) => {
          const response = await frontend.requestGetDiff({
            sessionId,
            file: args.file,
            stat: args.stat,
          });
          if (response.error) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Error getting diff: ${response.error}`,
                },
              ],
            };
          }
          return {
            content: [
              {
                type: 'text',
                text: response.diff || 'No changes found.',
              },
            ],
          };
        },
      ),
    ],
  });

export class ClaudeSessionManager {
  private readonly sessions = new Map<string, ClaudeSessionState>();

  async handleQuery(sessionId: string, prompt: string, options: QueryOptions, frontend: FrontendApi) {
    const existing = this.sessions.get(sessionId);
    const nextSettings = {
      claudeEnvVars: options.claudeEnvVars,
      additionalDirectories: options.additionalDirectories,
      ghToken: options.ghToken,
    };
    const shouldReset =
      options.shouldResetGenerator === true ||
      !existing ||
      settingsChanged(existing.currentSettings, nextSettings);

    let session = existing;
    if (!session || shouldReset) {
      if (session?.terminate) {
        session.terminate();
      }
      session = {
        currentModel: options.model,
        currentPermissionMode: normalizePermissionMode(options.permissionMode),
        currentSettings: nextSettings,
        lastAssistantText: '',
      };
      this.sessions.set(sessionId, session);
      session.streaming = this.startStreaming(sessionId, session, options, frontend);
    } else if (session.query && options.permissionMode) {
      void session.query.setPermissionMode(normalizePermissionMode(options.permissionMode));
    }

    if (!session?.sendMessage) {
      session.streaming = this.startStreaming(sessionId, session, options, frontend);
    }
    session?.sendMessage?.(prompt);
  }

  async handleCancel(sessionId: string, frontend: FrontendApi) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.query) {
      return;
    }
    try {
      await session.query.interrupt();
      session.terminate?.();
      frontend.sendError({
        id: sessionId,
        type: 'error',
        error: 'aborted by user',
        agentType: 'claude' satisfies AgentType,
      });
    } catch (error) {
      console.error('[Claude] cancel failed:', error);
    }
    this.sessions.delete(sessionId);
  }

  async handlePermissionModeUpdate(sessionId: string, permissionMode: string) {
    const session = this.sessions.get(sessionId);
    if (!session?.query) {
      return;
    }
    try {
      await session.query.setPermissionMode(normalizePermissionMode(permissionMode));
      session.currentPermissionMode = normalizePermissionMode(permissionMode);
    } catch (error) {
      console.error('[Claude] permission update failed:', error);
    }
  }

  async claudeAuth(id: string, cwd: string) {
    const queryResult = query({
      prompt: '',
      options: {
        cwd,
        pathToClaudeCodeExecutable: resolveClaudeCliPath(),
        systemPrompt: DEFAULT_PROMPT,
      },
    });
    const accountInfo = await queryResult.accountInfo();
    await queryResult.interrupt();
    return {
      id,
      type: 'claude_auth_output',
      agentType: 'claude' satisfies AgentType,
      accountInfo,
    };
  }

  async workspaceInit(id: string, options: QueryOptions) {
    const queryResult = query({
      prompt: '',
      options: {
        cwd: options.cwd,
        pathToClaudeCodeExecutable: resolveClaudeCliPath(),
        systemPrompt: DEFAULT_PROMPT,
        settingSources: DEFAULT_SETTING_SOURCES,
        env: buildClaudeEnv(options),
      },
    });
    const [slashCommands, mcpServers] = await Promise.all([
      queryResult.supportedCommands(),
      queryResult.mcpServerStatus(),
    ]);
    await queryResult.interrupt();
    return {
      id,
      type: 'workspace_init_output',
      agentType: 'claude' satisfies AgentType,
      slashCommands,
      mcpServers,
    };
  }

  async contextUsage(id: string, options: QueryOptions & { claudeSessionId: string }) {
    const queryResult = query({
      prompt: '/context',
      options: {
        cwd: options.cwd,
        resume: options.claudeSessionId,
        pathToClaudeCodeExecutable: resolveClaudeCliPath(),
        systemPrompt: DEFAULT_PROMPT,
        settingSources: DEFAULT_SETTING_SOURCES,
      },
    });
    for await (const message of queryResult) {
      if (message.type !== 'user') continue;
      await queryResult.interrupt();
      return {
        type: 'context_usage',
        id,
        agentType: 'claude' satisfies AgentType,
        contextUsageData: message,
      };
    }
    await queryResult.interrupt();
    throw new Error('No context usage response');
  }

  private async startStreaming(
    sessionId: string,
    session: ClaudeSessionState,
    options: QueryOptions,
    frontend: FrontendApi,
  ) {
    const messageQueue: string[] = [];
    let waiting: ((value: string) => void) | null = null;
    let terminated = false;

    session.sendMessage = (message: string) => {
      messageQueue.push(message);
      if (waiting) {
        const resolver = waiting;
        waiting = null;
        resolver(messageQueue.shift() ?? '');
      }
    };
    session.terminate = () => {
      terminated = true;
      if (waiting) {
        const resolver = waiting;
        waiting = null;
        resolver('');
      }
    };

    const promptStream = (async function* () {
      while (true) {
        let message: string;
        if (messageQueue.length > 0) {
          message = messageQueue.shift() ?? '';
        } else {
          message = await new Promise<string>((resolve) => {
            waiting = resolve;
          });
        }
        if (terminated) {
          break;
        }
        if (!message) {
          continue;
        }
        yield {
          type: 'user',
          message: { role: 'user', content: message },
          parent_tool_use_id: null,
          session_id: sessionId,
        };
      }
    })();

    try {
      const canUseTool = async (toolName: string, input: Record<string, unknown>, toolOptions: { toolUseID: string }) => {
        if (toolName === 'ExitPlanMode') {
          const response = await frontend.requestExitPlanMode({
            sessionId,
            toolInput: input,
          });
          if (response.approved) {
            return {
              behavior: 'allow',
              updatedInput: input,
              updatedPermissions: [
                { type: 'setMode', mode: 'default', destination: 'session' },
              ],
            };
          }
          return {
            behavior: 'deny',
            message: 'Plan denied by user. Please await further guidance.',
            interrupt: true,
            toolUseID: toolOptions.toolUseID,
          };
        }
        return { behavior: 'allow', updatedInput: input };
      };

      const sdkOptions = {
        cwd: options.cwd,
        model: options.model,
        permissionMode: normalizePermissionMode(options.permissionMode),
        pathToClaudeCodeExecutable: resolveClaudeCliPath(),
        systemPrompt: DEFAULT_PROMPT,
        settingSources: DEFAULT_SETTING_SOURCES,
        includePartialMessages: true,
        additionalDirectories: options.additionalDirectories ?? [],
        env: buildClaudeEnv(options),
        canUseTool,
        mcpServers: {
          conductor: createConductorMcpServer(sessionId, frontend),
        },
        hooks: {
          PostToolUse: [
            {
              matcher: 'EnterPlanMode',
              hooks: [
                async () => {
                  frontend.sendEnterPlanMode({
                    type: 'enter_plan_mode_notification',
                    id: sessionId,
                    agentType: 'claude' satisfies AgentType,
                  });
                  return {};
                },
              ],
            },
          ],
        },
        resume: options.resume,
        resumeSessionAt: options.resumeSessionAt,
      };

      const queryResult = query({ prompt: promptStream, options: sdkOptions });
      session.query = queryResult;

      for await (const message of queryResult) {
        const { delta, full, isFinal, sessionId: agentSessionId } = extractClaudeText(
          message,
          session.lastAssistantText,
        );
        if (full !== undefined) {
          session.lastAssistantText = full;
        } else if (delta) {
          session.lastAssistantText += delta;
        }
        if (agentSessionId) {
          session.claudeSessionId = agentSessionId;
        }
        frontend.sendMessage({
          id: sessionId,
          type: 'message',
          agentType: 'claude' satisfies AgentType,
          data: message,
          textDelta: delta,
          text: full,
          isFinal,
          agentSessionId: agentSessionId ?? session.claudeSessionId,
        });
      }
    } catch (error) {
      console.error('[Claude] streaming error:', error);
      frontend.sendError({
        id: sessionId,
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
        agentType: 'claude' satisfies AgentType,
      });
    }
  }
}
