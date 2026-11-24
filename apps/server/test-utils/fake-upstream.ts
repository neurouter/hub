import { createMcpHandler, Server, type CallToolResult, type JSONRPCMessage, type Transport } from '@modelcontextprotocol/server';

/**
 * In-process fake upstream MCP server for unit tests (backend §15): a real SDK server exposed
 * through a `fetch` function, so the gateway's upstream client talks to it with no sockets.
 *
 * Variants:
 * - `modern`: createMcpHandler (2026-07-28, with stateless 2025-11-25 fallback)
 * - `legacy`: answers `server/discover` with method-not-found, so negotiating clients fall back to `initialize`
 * - `sse`: legacy HTTP+SSE transport (GET event stream + POST endpoint)
 * Behaviour knobs: `delayMs` (slow), `failNext` (flaky: next N HTTP requests get 503),
 * `requireAuth` (401 + WWW-Authenticate unless the header matches), mutable tool list.
 */
export interface FakeTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  /** Default handler echoes the arguments as text. */
  handler?: (args: Record<string, unknown>, extra: { headers: Headers }) => CallToolResult | Promise<CallToolResult>;
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export type FakeVariant = 'modern' | 'legacy' | 'sse';

export interface FakeUpstreamOptions {
  variant?: FakeVariant;
  name?: string;
  version?: string;
  tools?: FakeTool[];
  /** e.g. `{ header: 'authorization', value: 'Bearer up-secret' }` */
  requireAuth?: { header: string; value: string };
  delayMs?: number;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export class FakeUpstream {
  readonly url: string;
  readonly variant: FakeVariant;
  tools: FakeTool[];
  readonly requests: RecordedRequest[] = [];
  readonly calls: { name: string; args: Record<string, unknown>; meta: unknown; headers: Headers }[] = [];
  failNext = 0;
  delayMs: number;
  requireAuth: FakeUpstreamOptions['requireAuth'];
  private readonly info: { name: string; version: string };
  private readonly handler;
  private readonly sseSessions = new Map<string, { transport: StreamTransport }>();
  private currentHeaders = new Headers();

  constructor(opts: FakeUpstreamOptions = {}) {
    this.variant = opts.variant ?? 'modern';
    this.url = this.variant === 'sse' ? 'http://upstream.test/sse' : 'http://upstream.test/mcp';
    this.tools = opts.tools ?? [{ name: 'echo', description: 'Echo the input text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }];
    this.info = { name: opts.name ?? 'fake-upstream', version: opts.version ?? '1.0.0' };
    this.requireAuth = opts.requireAuth;
    this.delayMs = opts.delayMs ?? 0;
    this.handler = createMcpHandler(() => this.buildServer(), { legacy: 'stateless' });
  }

  private buildServer(): Server {
    const s = new Server(this.info, { capabilities: { tools: { listChanged: true } } });
    s.setRequestHandler('tools/list', async () => ({
      tools: this.tools.map((t) => ({
        name: t.name,
        ...(t.title ? { title: t.title } : {}),
        description: t.description ?? '',
        inputSchema: (t.inputSchema ?? { type: 'object' }) as { type: 'object' },
        ...(t.outputSchema ? { outputSchema: t.outputSchema as { type: 'object' } } : {}),
        ...(t.annotations ? { annotations: t.annotations } : {}),
      })),
    }));
    s.setRequestHandler('tools/call', async (req, ctx) => {
      const tool = this.tools.find((t) => t.name === req.params.name);
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      const headers = this.currentHeaders;
      this.calls.push({ name: req.params.name, args, meta: ctx.mcpReq._meta ?? null, headers });
      if (!tool) return { content: [{ type: 'text', text: `Unknown tool ${req.params.name}` }], isError: true };
      if (this.delayMs) await sleep(this.delayMs, ctx.mcpReq.signal);
      const result = tool.handler ? await tool.handler(args, { headers }) : { content: [{ type: 'text' as const, text: JSON.stringify(args) }] };
      return s.projectCallToolResult(result, tool.outputSchema);
    });
    return s;
  }

  /** The `fetch` the gateway's upstream client uses. */
  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init);
    const text = req.method === 'POST' ? await req.clone().text() : '';
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    this.requests.push({ method: req.method, url: req.url, headers: Object.fromEntries(req.headers), body });
    if (this.failNext > 0) {
      this.failNext--;
      return new Response('unavailable', { status: 503 });
    }
    if (this.requireAuth && req.headers.get(this.requireAuth.header) !== this.requireAuth.value) {
      return json(401, { error: 'invalid_token' }, { 'www-authenticate': 'Bearer resource_metadata="http://upstream.test/.well-known/oauth-protected-resource"' });
    }
    this.currentHeaders = req.headers;
    if (this.variant === 'sse') return this.sseFetch(req, body);
    if (this.variant === 'legacy' && body && typeof body === 'object' && (body as { method?: string }).method === 'server/discover') {
      return json(200, { jsonrpc: '2.0', id: (body as { id: unknown }).id, error: { code: -32601, message: 'Method not found' } });
    }
    return this.handler.fetch(new Request(req.url, { method: req.method, headers: req.headers, ...(req.method === 'POST' ? { body: text } : {}) }));
  };

  private async sseFetch(req: Request, body: unknown): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/sse') {
      const id = Math.random().toString(36).slice(2);
      const transport = new StreamTransport();
      this.sseSessions.set(id, { transport });
      const server = this.buildServer();
      await server.connect(transport);
      transport.write(`event: endpoint\ndata: /messages?sessionId=${id}\n\n`);
      return new Response(transport.stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
    }
    if (req.method === 'POST' && url.pathname === '/messages') {
      const sess = this.sseSessions.get(url.searchParams.get('sessionId') ?? '');
      if (!sess) return new Response('unknown session', { status: 404 });
      sess.transport.onmessage?.(body as JSONRPCMessage);
      return new Response('Accepted', { status: 202 });
    }
    return new Response('not found', { status: 404 });
  }

  /** Requests whose JSON-RPC method matches. */
  requestsFor(method: string): RecordedRequest[] {
    return this.requests.filter((r) => (r.body as { method?: string } | null)?.method === method);
  }

  async close(): Promise<void> {
    for (const s of this.sseSessions.values()) await s.transport.close();
    await this.handler.close();
  }
}

/** Server-side transport for the legacy HTTP+SSE variant: messages go out as SSE frames. */
class StreamTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private closed = false;
  readonly stream = new ReadableStream<Uint8Array>({
    start: (c) => {
      this.controller = c;
    },
    cancel: () => {
      this.closed = true;
      this.onclose?.();
    },
  });
  async start(): Promise<void> {}
  write(frame: string): void {
    if (!this.closed) this.controller.enqueue(new TextEncoder().encode(frame));
  }
  async send(message: JSONRPCMessage): Promise<void> {
    this.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.controller.close();
    } catch {
      // already errored
    }
    this.onclose?.();
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason);
    });
  });
}
