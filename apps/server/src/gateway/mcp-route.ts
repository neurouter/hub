import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createMcpHandler, Server, type McpHttpHandler, type McpRequestContext, type ServerEventBus } from '@modelcontextprotocol/server';
import { META_TOOL_DEFINITIONS } from '@neurouter/shared';
import type { McpAuthenticator } from '../auth/mcp/authenticate.js';
import { bearerChallenge, protectedResourceMetadata } from '../auth/mcp/challenge.js';
import type { GatewayPipeline } from './call-pipeline.js';
import { RC_KEY, type RequestContext } from './context.js';
import { InflightCalls, inspectJsonRpc, LegacyClientInfo } from './inflight.js';
import { originAllowed } from './origin.js';

export interface McpRouteDeps {
  publicUrl: string;
  resourceUri: string;
  allowedOrigins: readonly string[];
  version: string;
  authenticator: McpAuthenticator;
  pipeline: GatewayPipeline;
  bus: ServerEventBus;
  /** SSE keep-alive interval (backend: 15 s). */
  keepAliveMs?: number;
  onAuthFailure?: (reason: string, method: 'api_key' | 'oauth') => void;
  /** Links `notifications/cancelled` (separate POST) to the held `tools/call`; cross-replica via coordination. */
  inflight?: InflightCalls;
  legacyClients?: LegacyClientInfo;
}

const INSTRUCTIONS =
  'This gateway exposes two tools. Call search_tools with what you want to do to find the tools you are allowed to use (with their input schemas), then call call_tool with the exact name and arguments.';

/**
 * Per-request low-level SDK server (backend §5.1 server-factory): Phase 1 lists exactly the two
 * meta-tools (decision 40); `tools/list` is per-principal (`cacheScope: private`, ttl 60 s).
 */
export function buildServerFactory(d: Pick<McpRouteDeps, 'version' | 'pipeline'>) {
  return (ctx: McpRequestContext): Server => {
    const rc = (ctx.authInfo?.extra as Record<string, unknown> | undefined)?.[RC_KEY] as RequestContext | undefined;
    if (!rc) throw new Error('unauthenticated MCP request reached the server factory');
    const server = new Server(
      { name: 'neurouter', version: d.version },
      {
        capabilities: { tools: { listChanged: true } },
        instructions: INSTRUCTIONS,
        cacheHints: { 'tools/list': { ttlMs: 60_000, cacheScope: 'private' } },
      },
    );
    server.setRequestHandler('tools/list', async (_req, c) => {
      d.pipeline.auditList(rc, d.pipeline.callInfo(c, server, ctx.era, rc));
      return { tools: META_TOOL_DEFINITIONS.map((t) => structuredClone(t)) as never };
    });
    server.setRequestHandler('tools/call', async (req, c) => {
      const out = await d.pipeline.handle(rc, c, server, ctx.era, { name: req.params.name, ...(req.params.arguments ? { arguments: req.params.arguments } : {}) });
      if ((out as { resultType?: string }).resultType === 'input_required') return out as never;
      return server.projectCallToolResult(out as never, undefined);
    });
    return server;
  };
}

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * `/mcp` (backend §5.1): Origin check → bearer auth (401/403 challenges) → SDK handler. A
 * `tools/call` (by `Mcp-Method`) goes to the SSE handler so held calls keep the stream alive;
 * everything else is served `auto`. Fastify ↔ WHATWG bridge with client-abort propagation.
 */
export async function mcpRoutes(app: FastifyInstance, d: McpRouteDeps): Promise<{ handlers: McpHttpHandler[] }> {
  const factory = buildServerFactory(d);
  const inflight = d.inflight ?? new InflightCalls();
  const legacyClients = d.legacyClients ?? new LegacyClientInfo();
  const common = { legacy: 'stateless' as const, bus: d.bus, keepAliveMs: d.keepAliveMs ?? 15_000, maxRequestBodySize: 4 * 1024 * 1024 };
  const callHandler = createMcpHandler(factory, { ...common, responseMode: 'sse' });
  const defaultHandler = createMcpHandler(factory, { ...common, responseMode: 'auto' });

  const prm = protectedResourceMetadata(d.publicUrl, d.resourceUri);
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    app.get(path, async (_req, reply) => reply.header('cache-control', 'public, max-age=3600').header('access-control-allow-origin', '*').send(prm));
  }

  await app.register(async (scope) => {
    // keep the body raw: the SDK parses and validates it (parse errors → JSON-RPC -32700, wrong media type → 415)
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'string', bodyLimit: 4 * 1024 * 1024 }, (_req, body, done) => done(null, body));

    const handle = async (req: FastifyRequest, reply: FastifyReply) => {
      if (!originAllowed(header(req, 'origin'), d.publicUrl, d.allowedOrigins)) {
        return reply.status(403).type('application/json').send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Origin not allowed' } });
      }
      const auth = await d.authenticator.authenticate(header(req, 'authorization'), { ip: req.ip });
      if (!auth.ok) {
        d.onAuthFailure?.(auth.reason, /^bearer\s+nr_at_/i.test(header(req, 'authorization') ?? '') ? 'oauth' : 'api_key');
        const status = auth.error === 'insufficient_scope' ? 403 : 401;
        const challenge = bearerChallenge(d.publicUrl, auth.error === 'missing_token' ? undefined : auth.error);
        return reply
          .status(status)
          .header('www-authenticate', challenge)
          .type('application/json')
          .send({ error: auth.error === 'missing_token' ? 'unauthorized' : auth.error, error_description: auth.error === 'missing_token' ? 'Authentication required' : 'The access token is invalid or not permitted' });
      }
      const ua = header(req, 'user-agent');
      const body = req.method === 'POST' ? ((req.body as string | undefined) ?? '') : undefined;
      const credentialId = auth.principal.credentialId;
      const sessionId = header(req, 'mcp-session-id') ?? null;
      const rpc = inspectJsonRpc(body);
      if (rpc.initialize) legacyClients.remember(credentialId, sessionId, rpc.initialize);
      // a cancel for a call held here (or on another replica) aborts its signal → approval cancelled
      for (const id of rpc.cancels) void inflight.cancel(credentialId, id).catch(() => {});
      const rc: RequestContext = {
        principal: auth.principal,
        ip: req.ip,
        userAgent: ua ? ua.slice(0, 512) : null,
        traceparent: header(req, 'traceparent') ?? null,
        legacySessionId: sessionId,
        legacyClient: legacyClients.get(credentialId, sessionId),
      };
      const abort = new AbortController();
      const releases = rpc.calls.map((id) => inflight.register(credentialId, id, abort));
      const release = () => {
        for (const r of releases.splice(0)) r();
      };
      // the response closing before it ended means the client went away (or, on a 2026-era
      // connection, aborted the per-request stream as its cancellation signal). `req` 'close' is
      // not usable here: it already fired once Fastify consumed the body.
      reply.raw.once('close', () => {
        if (!reply.raw.writableEnded) abort.abort(new Error('client disconnected'));
        release();
      });
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined || k === 'host' || k === 'connection' || k === 'content-length') continue;
        headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      }
      const request = new Request(new URL(req.url, d.publicUrl), { method: req.method, headers, signal: abort.signal, ...(body !== undefined ? { body } : {}) });
      const handler = header(req, 'mcp-method') === 'tools/call' ? callHandler : defaultHandler;
      let res: Response;
      try {
        res = await handler.fetch(request, {
          authInfo: { token: '', clientId: auth.principal.agent.id, scopes: auth.principal.scopes, resource: new URL(d.resourceUri), extra: { [RC_KEY]: rc } },
        });
      } catch (err) {
        release();
        throw err;
      }
      reply.status(res.status);
      res.headers.forEach((value, key) => {
        if (key !== 'content-length') reply.header(key, value);
      });
      if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) reply.header('x-accel-buffering', 'no').header('cache-control', 'no-cache, no-transform');
      if (!res.body) {
        release();
        return reply.send();
      }
      return reply.send(Readable.fromWeb(res.body as never));
    };
    scope.post('/mcp', handle);
    scope.get('/mcp', handle);
    scope.delete('/mcp', handle);
  });
  return { handlers: [callHandler, defaultHandler] };
}
