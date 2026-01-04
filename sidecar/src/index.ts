import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ClaudeSessionManager } from './claude.js';
import { CodexSessionManager } from './codex.js';
import { JsonRpcPeer } from './rpc.js';
import {
  FRONTEND_NOTIFICATIONS,
  FRONTEND_RPC_METHODS,
  SIDECAR_METHODS,
  SIDECAR_NOTIFICATIONS,
  isCancelRequest,
  isClaudeAuthRequest,
  isContextUsageRequest,
  isQueryRequest,
  isUpdatePermissionModeRequest,
  isWorkspaceInitRequest,
} from './protocol.js';

const logPrefix = '[sidecar]';

class SidecarServer {
  private readonly socketPath: string;
  private readonly server: net.Server;
  private readonly claudeManager = new ClaudeSessionManager();
  private readonly codexManager = new CodexSessionManager();

  constructor() {
    this.socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\supertree-sidecar-${process.pid}`
        : path.join(os.tmpdir(), `supertree-sidecar-${process.pid}.sock`);

    this.server = net.createServer((socket) => this.handleConnection(socket));
    this.server.on('error', (error) => {
      console.error(`${logPrefix} server error`, error);
    });

    process.on('SIGINT', () => this.shutdown('SIGINT'));
    process.on('SIGTERM', () => this.shutdown('SIGTERM'));
  }

  async start() {
    await this.cleanup();
    await new Promise<void>((resolve, reject) => {
      this.server.listen(this.socketPath, () => {
        console.log(`${logPrefix} listening on ${this.socketPath}`);
        console.log(`SOCKET_PATH=${this.socketPath}`);
        resolve();
      });
      this.server.once('error', reject);
    });
  }

  private handleConnection(socket: net.Socket) {
    const rpc = new JsonRpcPeer(socket);
    const frontend = {
      sendMessage: (payload: unknown) => rpc.notify(FRONTEND_NOTIFICATIONS.MESSAGE, payload),
      sendError: (payload: unknown) => rpc.notify(FRONTEND_NOTIFICATIONS.QUERY_ERROR, payload),
      sendEnterPlanMode: (payload: unknown) =>
        rpc.notify(FRONTEND_NOTIFICATIONS.ENTER_PLAN_MODE, payload),
      requestExitPlanMode: (payload: { sessionId: string; toolInput: unknown }) =>
        rpc.request(FRONTEND_RPC_METHODS.EXIT_PLAN_MODE, payload) as Promise<{
          approved: boolean;
          turnId?: number | null;
        }>,
      requestAskUserQuestion: (payload: {
        sessionId: string;
        questions: Array<{ question: string; options: string[] }>;
      }) =>
        rpc.request(FRONTEND_RPC_METHODS.ASK_USER_QUESTION, payload) as Promise<{
          answers: string[];
        }>,
      requestGetDiff: (payload: { sessionId: string; file?: string; stat?: boolean }) =>
        rpc.request(FRONTEND_RPC_METHODS.GET_DIFF, payload) as Promise<{
          diff?: string;
          error?: string;
        }>,
    };

    rpc.addMethod(SIDECAR_NOTIFICATIONS.QUERY, async (params) => {
      if (!isQueryRequest(params)) return;
      if (params.agentType === 'codex') {
        this.codexManager
          .handleQuery(params.id, params.prompt, params.options, frontend)
          .catch((error) => {
            frontend.sendError({
              id: params.id,
              type: 'error',
              agentType: 'codex',
              error: error instanceof Error ? error.message : String(error),
            });
          });
      } else {
        await this.claudeManager.handleQuery(params.id, params.prompt, params.options, frontend);
      }
    });

    rpc.addMethod(SIDECAR_METHODS.CANCEL, async (params) => {
      if (!isCancelRequest(params)) return;
      if (params.agentType === 'codex') {
        this.codexManager.handleCancel(params.id, frontend);
      } else {
        await this.claudeManager.handleCancel(params.id, frontend);
      }
    });

    rpc.addMethod(SIDECAR_METHODS.CLAUDE_AUTH, async (params) => {
      if (!isClaudeAuthRequest(params)) {
        throw new Error('Invalid claudeAuth request');
      }
      return this.claudeManager.claudeAuth(params.id, params.options.cwd);
    });

    rpc.addMethod(SIDECAR_METHODS.WORKSPACE_INIT, async (params) => {
      if (!isWorkspaceInitRequest(params)) {
        throw new Error('Invalid workspaceInit request');
      }
      return this.claudeManager.workspaceInit(params.id, params.options);
    });

    rpc.addMethod(SIDECAR_METHODS.CONTEXT_USAGE, async (params) => {
      if (!isContextUsageRequest(params)) {
        throw new Error('Invalid contextUsage request');
      }
      return this.claudeManager.contextUsage(params.id, {
        ...params.options,
        claudeSessionId: params.options.claudeSessionId,
      });
    });

    rpc.addMethod(SIDECAR_NOTIFICATIONS.UPDATE_PERMISSION_MODE, async (params) => {
      if (!isUpdatePermissionModeRequest(params)) return;
      await this.claudeManager.handlePermissionModeUpdate(params.id, params.permissionMode);
    });

    let buffer = '';
    socket.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) {
          rpc.handleLine(line);
        }
      }
    });
    socket.on('close', () => rpc.stop());
  }

  private async cleanup() {
    if (process.platform !== 'win32' && fs.existsSync(this.socketPath)) {
      try {
        fs.unlinkSync(this.socketPath);
      } catch (error) {
        console.warn(`${logPrefix} failed to remove socket`, error);
      }
    }
  }

  private shutdown(signal: string) {
    console.log(`${logPrefix} received ${signal}, shutting down`);
    try {
      this.server.close();
    } catch (error) {
      console.error(`${logPrefix} server close failed`, error);
    }
    process.exit(0);
  }
}

process.on('uncaughtException', (error) => {
  console.error(`${logPrefix} uncaught exception`, error);
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  console.error(`${logPrefix} unhandled rejection`, error);
  process.exit(1);
});

const server = new SidecarServer();
server.start().catch((error) => {
  console.error(`${logPrefix} failed to start`, error);
  process.exit(1);
});
