import type net from 'node:net';

type JsonRpcId = string | number;

type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
};

type RpcHandler = (params: unknown) => Promise<unknown> | unknown;

const REQUEST_TIMEOUT_MS = 30_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const safeJsonParse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export class JsonRpcPeer {
  private readonly socket: net.Socket;
  private readonly methods = new Map<string, RpcHandler>();
  private readonly pending = new Map<
    JsonRpcId,
    { resolve: (value: unknown) => void; reject: (err: Error) => void; timeout: ReturnType<typeof setTimeout> }
  >();
  private nextId = 1;

  constructor(socket: net.Socket) {
    this.socket = socket;
  }

  addMethod(name: string, handler: RpcHandler) {
    this.methods.set(name, handler);
  }

  notify(method: string, params?: unknown) {
    const payload: JsonRpcRequest = { jsonrpc: '2.0', method, params };
    this.send(payload);
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const payload: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    if (!this.send(payload)) {
      return Promise.reject(new Error('Failed to send JSON-RPC request'));
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC request timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeout });
    });
  }

  stop() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('JSON-RPC peer stopped'));
    }
    this.pending.clear();
  }

  handleLine(line: string) {
    const payload = safeJsonParse(line);
    if (payload === undefined) {
      console.error('[JsonRpcPeer] Failed to parse JSON:', line);
      return;
    }
    if (Array.isArray(payload)) {
      for (const entry of payload) {
        this.handlePayload(entry);
      }
      return;
    }
    this.handlePayload(payload);
  }

  private handlePayload(payload: unknown) {
    if (!isRecord(payload)) {
      console.error('[JsonRpcPeer] Invalid JSON-RPC payload:', payload);
      return;
    }
    if ('method' in payload) {
      const method = payload.method;
      if (typeof method !== 'string') {
        console.error('[JsonRpcPeer] JSON-RPC method missing or invalid:', payload);
        return;
      }
      const id = payload.id;
      if (id !== undefined) {
        if (typeof id !== 'string' && typeof id !== 'number') {
          console.error('[JsonRpcPeer] JSON-RPC id missing or invalid:', payload);
          return;
        }
        void this.handleRequest(method, id as JsonRpcId, payload.params);
      } else {
        void this.handleNotification(method, payload.params);
      }
      return;
    }
    if ('id' in payload) {
      this.handleResponse(payload as JsonRpcResponse);
      return;
    }
    console.error('[JsonRpcPeer] Unsupported JSON-RPC payload:', payload);
  }

  private async handleRequest(method: string, id: JsonRpcId, params?: unknown) {
    const handler = this.methods.get(method);
    if (!handler) {
      this.send({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
      return;
    }
    try {
      const result = await handler(params);
      const response: JsonRpcResponse = { jsonrpc: '2.0', id, result };
      this.send(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const response: JsonRpcResponse = {
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message },
      };
      this.send(response);
    }
  }

  private async handleNotification(method: string, params?: unknown) {
    const handler = this.methods.get(method);
    if (!handler) {
      console.warn('[JsonRpcPeer] Ignoring notification for missing method', method);
      return;
    }
    try {
      await handler(params);
    } catch (error) {
      console.error('[JsonRpcPeer] Notification handler failed:', error);
    }
  }

  private handleResponse(response: JsonRpcResponse) {
    const pending = this.pending.get(response.id);
    if (!pending) {
      console.warn('[JsonRpcPeer] Response without pending request:', response.id);
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(response.id);
    if (response.error) {
      pending.reject(new Error(response.error.message));
    } else {
      pending.resolve(response.result);
    }
  }

  private send(payload: JsonRpcRequest | JsonRpcResponse) {
    try {
      this.socket.write(`${JSON.stringify(payload)}\n`);
      return true;
    } catch (error) {
      console.error('[JsonRpcPeer] Failed to send payload:', error);
      return false;
    }
  }
}
