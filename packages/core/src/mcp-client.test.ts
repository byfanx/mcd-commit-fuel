import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpClient, parseRpcResponse } from './mcp-client.js';
import { McpError } from './errors.js';

const TOKEN = 'test-token-0000';

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;
const routes = new Map<string, Handler>();
let server: Server;
let base: string;

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

function ok(data: unknown) {
  return {
    jsonrpc: '2.0',
    id: 1,
    result: {
      isError: false,
      content: [{ type: 'text', text: '给模型看的 Markdown' }],
      structuredContent: { success: true, code: 200, message: '请求成功', data },
    },
  };
}

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const handler = routes.get(req.url ?? '');
      if (handler) handler(req, body, res);
      else json(res, 404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

function route(path: string, handler: Handler): McpClient {
  routes.set(path, handler);
  return new McpClient({ token: TOKEN, endpoint: base + path, timeoutMs: 500 });
}

async function rejectsWith(p: Promise<unknown>, kind: McpError['kind']): Promise<McpError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof McpError, `expected McpError, got ${String(err)}`);
    assert.equal(err.kind, kind, err.message);
    assert.ok(!err.message.includes(TOKEN), 'error message must not leak token');
    return err;
  }
  assert.fail(`expected ${kind} error`);
}

test('sends JSON-RPC tools/call with bearer token and returns structuredContent.data', async () => {
  let seen: { auth?: string | undefined; accept?: string | undefined; body?: unknown } = {};
  const client = route('/ok', (req, body, res) => {
    seen = { auth: req.headers.authorization, accept: req.headers.accept, body: JSON.parse(body) };
    json(res, 200, ok({ availablePoint: '12.5' }));
  });

  assert.deepEqual(await client.callTool('query-my-account'), { availablePoint: '12.5' });
  assert.equal(seen.auth, `Bearer ${TOKEN}`);
  assert.match(seen.accept ?? '', /application\/json/);
  assert.match(seen.accept ?? '', /text\/event-stream/);
  assert.deepEqual((seen.body as { method: string; params: unknown }).method, 'tools/call');
  assert.deepEqual((seen.body as { params: unknown }).params, { name: 'query-my-account', arguments: {} });
});

test('parses SSE responses', async () => {
  const client = route('/sse', (_req, _body, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`event: message\ndata: ${JSON.stringify(ok([1, 2]))}\n\n`);
  });
  assert.deepEqual(await client.callTool('x'), [1, 2]);
});

test('falls back to parsing content text when structuredContent is missing', async () => {
  const client = route('/text', (_req, _body, res) => {
    json(res, 200, {
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify({ success: true, data: 'hi' }) }] },
    });
  });
  assert.equal(await client.callTool('x'), 'hi');
});

test('401 → AUTH', async () => {
  const client = route('/401', (_req, _body, res) => json(res, 401, {}));
  const err = await rejectsWith(client.callTool('x'), 'AUTH');
  assert.equal(err.detail.status, 401);
});

test('500 → NETWORK', async () => {
  const client = route('/500', (_req, _body, res) => json(res, 500, {}));
  await rejectsWith(client.callTool('x'), 'NETWORK');
});

test('JSON-RPC error → TOOL with code', async () => {
  const client = route('/rpc-error', (_req, _body, res) =>
    json(res, 200, { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'unknown tool: x' } }),
  );
  const err = await rejectsWith(client.callTool('x'), 'TOOL');
  assert.equal(err.detail.code, -32602);
  assert.match(err.message, /unknown tool/);
});

test('result.isError → TOOL', async () => {
  const client = route('/is-error', (_req, _body, res) =>
    json(res, 200, { jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: '参数错误' }] } }),
  );
  const err = await rejectsWith(client.callTool('x'), 'TOOL');
  assert.match(err.message, /参数错误/);
});

test('success=false → BIZ', async () => {
  const client = route('/biz', (_req, _body, res) =>
    json(res, 200, {
      jsonrpc: '2.0',
      id: 1,
      result: { structuredContent: { success: false, code: 5001, message: '门店不存在', data: null } },
    }),
  );
  const err = await rejectsWith(client.callTool('x'), 'BIZ');
  assert.equal(err.detail.code, 5001);
  assert.match(err.message, /门店不存在/);
});

test('unparseable body → PROTOCOL', async () => {
  const client = route('/garbage', (_req, _body, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('<html>oops</html>');
  });
  await rejectsWith(client.callTool('x'), 'PROTOCOL');
});

test('timeout → NETWORK', async () => {
  const client = route('/slow', () => {
    /* never respond */
  });
  const err = await rejectsWith(client.callTool('x'), 'NETWORK');
  assert.match(err.message, /超时/);
});

test('connection refused → NETWORK', async () => {
  const client = new McpClient({ token: TOKEN, endpoint: 'http://127.0.0.1:1', timeoutMs: 500 });
  await rejectsWith(client.callTool('x'), 'NETWORK');
});

test('empty token → AUTH', () => {
  assert.throws(() => new McpClient({ token: '  ' }), (err: unknown) => err instanceof McpError && err.kind === 'AUTH');
});

test('token is not exposed by JSON.stringify', () => {
  const client = new McpClient({ token: TOKEN });
  assert.ok(!JSON.stringify(client).includes(TOKEN));
});

test('parseRpcResponse picks the last result event in an SSE stream', () => {
  const stream = [
    'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}',
    'data: {"jsonrpc":"2.0","id":1,"result":{"v":1}}',
    '',
  ].join('\n\n');
  assert.deepEqual(parseRpcResponse(stream, 'text/event-stream'), { jsonrpc: '2.0', id: 1, result: { v: 1 } });
});
