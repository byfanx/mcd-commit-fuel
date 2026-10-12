import { McpError } from './errors.js';
import { asNumber, asString, isObject, parseJson, type JsonObject } from './json.js';

export const DEFAULT_ENDPOINT = 'https://mcp.mcd.cn';
export const DEFAULT_TIMEOUT_MS = 10_000;

/** API 层只依赖这个接口，测试时可以换成桩。 */
export interface ToolCaller {
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
}

export interface McpClientOptions {
  token: string;
  endpoint?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

/**
 * 麦当劳 MCP 的最小客户端：直接 POST JSON-RPC `tools/call`，不需要握手和 session。
 * 返回 `structuredContent.data`；业务失败、协议错误都抛 McpError。
 */
export class McpClient implements ToolCaller {
  // 用私有字段保存 token，避免被 console.log / JSON.stringify 带出来
  readonly #token: string;
  readonly #endpoint: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;
  #nextId = 1;

  constructor(options: McpClientOptions) {
    const token = options.token.trim();
    if (!token) throw new McpError('AUTH', '未设置 MCP token');
    this.#token = token;
    this.#endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: this.#nextId++,
      method: 'tools/call',
      params: { name, arguments: args },
    });

    let res: Response;
    let text: string;
    try {
      res = await this.#fetch(this.#endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      text = await res.text();
    } catch (err) {
      throw new McpError('NETWORK', `${name} 请求失败：${this.#describe(err)}`);
    }

    if (res.status === 401 || res.status === 403) {
      throw new McpError('AUTH', `${name}：token 无效或已过期（HTTP ${res.status}）`, { status: res.status });
    }
    if (!res.ok) {
      throw new McpError('NETWORK', `${name}：HTTP ${res.status}`, { status: res.status });
    }

    const rpc = parseRpcResponse(text, res.headers.get('content-type') ?? '');
    if (!rpc) throw new McpError('PROTOCOL', `${name}：无法解析响应`);

    if (isObject(rpc.error)) {
      const code = asNumber(rpc.error.code);
      throw new McpError('TOOL', `${name}：${asString(rpc.error.message) ?? '调用失败'}`, code === undefined ? {} : { code });
    }

    const result = rpc.result;
    if (!isObject(result)) throw new McpError('PROTOCOL', `${name}：响应缺少 result`);
    if (result.isError === true) {
      throw new McpError('TOOL', `${name}：${firstText(result)?.slice(0, 200) ?? '调用失败'}`);
    }

    const payload = result.structuredContent ?? parseJson(firstText(result));
    if (payload === undefined) throw new McpError('PROTOCOL', `${name}：响应缺少结构化数据`);
    if (!isObject(payload) || typeof payload.success !== 'boolean') return payload;

    if (!payload.success) {
      const code = asNumber(payload.code);
      throw new McpError('BIZ', `${name}：${asString(payload.message) ?? '业务处理失败'}`, code === undefined ? {} : { code });
    }
    return payload.data;
  }

  #describe(err: unknown): string {
    if (err instanceof Error) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') return `超时（${this.#timeoutMs}ms）`;
      const cause = (err as { cause?: { code?: unknown } }).cause;
      if (typeof cause?.code === 'string') return cause.code;
      return err.message;
    }
    return String(err);
  }
}

function firstText(result: JsonObject): string | undefined {
  const content = result.content;
  if (!Array.isArray(content)) return undefined;
  for (const item of content) {
    if (isObject(item) && item.type === 'text' && typeof item.text === 'string') return item.text;
  }
  return undefined;
}

/** 普通 JSON 或 SSE 都能解析；SSE 取最后一条带 result/error 的事件。 */
export function parseRpcResponse(text: string, contentType: string): JsonObject | undefined {
  if (!contentType.includes('text/event-stream')) {
    const parsed = parseJson(text);
    if (isObject(parsed)) return parsed;
  }
  const events = text.split(/\r?\n\r?\n/);
  for (let i = events.length - 1; i >= 0; i--) {
    const data = (events[i] ?? '')
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    const parsed = parseJson(data);
    if (isObject(parsed) && ('result' in parsed || 'error' in parsed)) return parsed;
  }
  return undefined;
}
