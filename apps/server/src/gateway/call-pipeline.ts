import type { Kysely } from 'kysely';
import { ProtocolError, type CallToolResult, type Server, type ServerContext } from '@modelcontextprotocol/server';
import { CALL_TOOL_NAME, META_RETRY_AFTER_MS, META_SESSION_ID, MAX_SESSION_ID_LENGTH, META_TOOL_NAMES, SEARCH_TOOLS_NAME, type AuditDecision, type AuditStatus, type SearchToolsResult } from '@neurouter/shared';
import type { AuditRecorder } from '../audit/recorder.js';
import type { AuditEventInput } from '../audit/store.js';
import type { MainDB } from '../db/schema.js';
import type { Clock } from '../lib/clock.js';
import { newId } from '../lib/ids.js';
import { parseJsonColumn, toBool } from '../lib/json.js';
import type { AclService } from '../policy/acl-cache.js';
import type { RateLimiter } from '../policy/rate-limit/limiter.js';
import type { Keyring } from '../secrets/keyring.js';
import type { ToolSearchService } from '../search/search.service.js';
import { UpstreamError } from '../upstream/errors.js';
import { MAX_CALL_TIMEOUT_MS, type UpstreamPool } from '../upstream/pool.js';
import type { ApprovalGate } from './approval-gate.js';
import type { ArgValidator } from './arg-validate.js';
import { traceIdOf, type RequestContext } from './context.js';
import { startCallTrace } from '../observability/tracing.js';
import { RequestStateError, unwrapRequestState, wrapRequestState, type WrappedState } from './translate.js';

const MRTR_TTL_MS = 10 * 60_000;
const ENVELOPE_CAPS = 'io.modelcontextprotocol/clientCapabilities';
const ENVELOPE_CLIENT = 'io.modelcontextprotocol/clientInfo';
const ENVELOPE_VERSION = 'io.modelcontextprotocol/protocolVersion';

export interface GatewayDeps {
  db: Kysely<MainDB>;
  clock: Clock;
  acl: AclService;
  pool: UpstreamPool;
  limiter: RateLimiter;
  args: ArgValidator;
  search: ToolSearchService;
  audit: AuditRecorder;
  keyring: Keyring;
  approvals: ApprovalGate;
  publicUrl: string;
}

type Result = CallToolResult | { resultType: 'input_required'; inputRequests: Record<string, unknown>; requestState?: string };

interface CallInfo {
  era: 'modern' | 'legacy';
  clientName: string | null;
  clientVersion: string | null;
  protocolVersion: string | null;
  clientCaps: Record<string, unknown> | null;
  meta: Record<string, unknown>;
  progressToken: string | number | undefined;
}

const errorResult = (text: string, meta?: Record<string, unknown>): CallToolResult => ({ content: [{ type: 'text', text }], isError: true, ...(meta ? { _meta: meta } : {}) });

/** Session derivation inputs (backend §10.3); resolution itself happens in the audit writer (step 6). */
export function sessionKeyOf(meta: Record<string, unknown>, rc: Pick<RequestContext, 'traceparent' | 'legacySessionId'>): NonNullable<AuditEventInput['sessionKey']> {
  const sid = meta[META_SESSION_ID];
  if (typeof sid === 'string' && sid.length > 0 && sid.length <= MAX_SESSION_ID_LENGTH) return { source: 'client', externalKey: sid };
  const trace = traceIdOf(typeof meta.traceparent === 'string' ? meta.traceparent : null) ?? traceIdOf(rc.traceparent);
  if (trace) return { source: 'trace', externalKey: trace };
  if (rc.legacySessionId) return { source: 'legacy', externalKey: rc.legacySessionId.slice(0, 128) };
  return { source: 'idle_gap', externalKey: '' };
}

/**
 * The `tools/call` pipeline (backend §5.6): resolve → ACL (deny wins, unknown and denied look
 * the same) → pinned-schema arg validation → rate limits → approval → upstream (credential
 * injection, no client token forwarded) → result shaping (MRTR requestState wrapping) → audit.
 */
export class GatewayPipeline {
  constructor(private readonly d: GatewayDeps) {}

  callInfo(ctx: ServerContext, server: Server, era: 'modern' | 'legacy', rc?: Pick<RequestContext, 'legacyClient'>): CallInfo {
    const env = (ctx.mcpReq.envelope ?? {}) as Record<string, unknown>;
    // modern: per-request envelope; legacy: the stateless server never saw initialize, so use the remembered clientInfo
    const ci = (env[ENVELOPE_CLIENT] as { name?: string; version?: string } | undefined) ?? server.getClientVersion() ?? (rc?.legacyClient ? { name: rc.legacyClient.name ?? undefined, version: rc.legacyClient.version ?? undefined } : undefined);
    const meta = (ctx.mcpReq._meta ?? {}) as Record<string, unknown>;
    const pt = meta.progressToken;
    return {
      era,
      clientName: ci?.name ? String(ci.name).slice(0, 200) : null,
      clientVersion: ci?.version ? String(ci.version).slice(0, 100) : null,
      protocolVersion: (env[ENVELOPE_VERSION] as string | undefined) ?? server.getNegotiatedProtocolVersion() ?? rc?.legacyClient?.protocolVersion ?? null,
      clientCaps: (env[ENVELOPE_CAPS] as Record<string, unknown> | undefined) ?? null,
      meta,
      progressToken: typeof pt === 'string' || typeof pt === 'number' ? pt : undefined,
    };
  }

  private auditBase(rc: RequestContext, info: CallInfo, requestId: string): Omit<AuditEventInput, 'id' | 'ts' | 'kind' | 'decision' | 'status'> {
    const p = rc.principal;
    return {
      requestId,
      userId: p.user.id,
      agentId: p.agent.id,
      apiKeyId: p.authMethod === 'api_key' ? p.credentialId : null,
      oauthClientId: p.oauthClientId,
      clientName: info.clientName,
      clientVersion: info.clientVersion,
      protocolVersion: info.protocolVersion,
      clientEra: info.era,
      traceId: traceIdOf(typeof info.meta.traceparent === 'string' ? info.meta.traceparent : null) ?? traceIdOf(rc.traceparent),
      sessionKey: sessionKeyOf(info.meta, rc),
      ip: rc.ip,
      userAgent: rc.userAgent,
    };
  }

  /** `tools/list` audit (kind tools_list). The list itself is always the two meta-tools in P1. */
  auditList(rc: RequestContext, info: CallInfo): void {
    this.d.audit.record({ ...this.auditBase(rc, info, newId()), kind: 'tools_list', decision: 'allowed', status: 'ok' });
  }

  async handle(rc: RequestContext, ctx: ServerContext, server: Server, era: 'modern' | 'legacy', params: { name: string; arguments?: Record<string, unknown> }): Promise<Result> {
    const info = this.callInfo(ctx, server, era, rc);
    const requestId = newId();
    if (params.name === SEARCH_TOOLS_NAME) return this.searchTools(rc, info, requestId, params.arguments ?? {});
    if (params.name === CALL_TOOL_NAME) {
      const a = params.arguments ?? {};
      const inner = typeof a.name === 'string' ? a.name : '';
      const innerArgs = a.arguments === undefined ? {} : a.arguments;
      if (!inner || typeof innerArgs !== 'object' || innerArgs === null || Array.isArray(innerArgs)) return errorResult('call_tool needs { name: string, arguments?: object }');
      if ((META_TOOL_NAMES as readonly string[]).includes(inner)) return errorResult(`call_tool cannot call ${inner}`);
      return this.callTool(rc, ctx, info, requestId, inner, innerArgs as Record<string, unknown>, 'call_tool');
    }
    return this.callTool(rc, ctx, info, requestId, params.name, params.arguments ?? {}, 'direct');
  }

  private async searchTools(rc: RequestContext, info: CallInfo, requestId: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const limit = typeof args.limit === 'number' && Number.isInteger(args.limit) ? Math.min(25, Math.max(1, args.limit)) : 8;
    const server = typeof args.server === 'string' ? args.server : undefined;
    const includeSchemas = args.includeSchemas !== false;
    const start = this.d.clock.now();
    if (!query || query.length > 500) return errorResult('search_tools needs a query of 1–500 characters');
    const allowed = await this.d.acl.allowed(this.aclPrincipal(rc));
    const { mode, ...result }: SearchToolsResult & { mode: string } = await this.d.search.search({ query, limit, includeSchemas, ...(server ? { serverSlug: server } : {}) }, allowed);
    this.d.audit.record({ ...this.auditBase(rc, info, requestId), kind: 'tool_search', decision: 'allowed', status: 'ok', decisionReason: `search:${mode}`, params: { query, limit, server: server ?? null }, latencyMs: this.d.clock.now() - start });
    const listing = result.tools.length
      ? result.tools.map((t) => `${t.name} — ${t.description.split('\n')[0]!.slice(0, 200)}${t.requiresApproval ? ' (requires approval)' : ''}`).join('\n')
      : 'No matching tools you are allowed to use. Try rephrasing the query with different keywords.';
    return { content: [{ type: 'text', text: `${listing}\n\n${JSON.stringify(result)}` }], structuredContent: result as unknown as Record<string, unknown> };
  }

  private aclPrincipal(rc: RequestContext) {
    return { userId: rc.principal.user.id, groupIds: rc.principal.groupIds, agent: { id: rc.principal.agent.id, narrowed: rc.principal.agent.narrowed } };
  }

  private async callTool(rc: RequestContext, ctx: ServerContext, info: CallInfo, requestId: string, name: string, args: Record<string, unknown>, via: 'direct' | 'call_tool'): Promise<Result> {
    const start = this.d.clock.now();
    // fail closed when audit can't keep up (backend §9.1, Q4)
    if (!this.d.audit.canAccept()) return errorResult('Audit logging is unavailable, so tool calls are blocked until it recovers. Retry shortly.');
    const trace = startCallTrace({
      method: 'tools/call',
      toolName: name,
      metaTraceparent: typeof info.meta.traceparent === 'string' ? info.meta.traceparent : null,
      metaTracestate: typeof info.meta.tracestate === 'string' ? info.meta.tracestate : null,
      httpTraceparent: rc.traceparent,
      protocolVersion: info.protocolVersion,
    });
    const base = { ...this.auditBase(rc, info, requestId), traceId: trace.traceId, spanId: trace.spanId };
    const params = via === 'call_tool' ? { ...args, _via: 'call_tool' } : args;
    const record = (decision: AuditDecision, status: AuditStatus, extra: Partial<AuditEventInput> = {}) => {
      trace.end({ error: status === 'ok' ? null : status });
      return this.d.audit.record({ ...base, kind: 'tool_call', toolName: name, decision, status, params, latencyMs: this.d.clock.now() - start, ...extra });
    };
    const notFound = (): Result => {
      if (via === 'direct') throw new ProtocolError(-32602, `Unknown tool: ${name}`);
      return errorResult(`Tool not found or not permitted: ${name}. Use search_tools to find tools you can call.`);
    };

    // 1 resolve (exposed_name is unique)
    const t = await this.d.db
      .selectFrom('tools as t')
      .innerJoin('servers as s', 's.id', 't.server_id')
      .select(['t.id', 't.server_id', 't.upstream_name', 't.exposed_name', 't.title', 't.description', 't.input_schema', 't.output_schema', 't.annotations', 't.pinned_hash', 't.requires_approval', 't.approval_timeout_sec', 't.rate_limit', 's.name as server_name', 's.slug as server_slug', 's.url', 's.transport', 's.auth_mode', 's.timeout_ms', 's.rate_limit as server_rate_limit', 's.trusted'])
      .where('t.exposed_name', '=', name)
      .executeTakeFirst();
    if (!t) {
      record('denied_acl', 'blocked', { decisionReason: 'unknown_tool' });
      return notFound();
    }
    const ids = { serverId: t.server_id, toolId: t.id };

    // 2 ACL (tool/server state included); denied looks exactly like unknown
    const allowed = await this.d.acl.allowed(this.aclPrincipal(rc));
    if (!allowed.has(t.id) || !t.pinned_hash) {
      record('denied_acl', 'blocked', { ...ids, decisionReason: 'not_permitted_or_blocked' });
      return notFound();
    }

    // MRTR retry: verify the wrapped requestState binding before anything else is forwarded
    let upstreamState: WrappedState | null = null;
    const rawState = ctx.mcpReq.requestState<unknown>();
    if (rawState !== undefined) {
      try {
        upstreamState = typeof rawState === 'string' ? unwrapRequestState(this.d.keyring, rawState, { uid: rc.principal.user.id, aid: rc.principal.agent.id, now: this.d.clock.now(), srv: t.server_id, tool: t.id }) : (rawState as WrappedState);
        if (upstreamState.srv !== t.server_id || upstreamState.tool !== t.id) throw new RequestStateError('bound to another tool');
      } catch (err) {
        record('denied_acl', 'blocked', { ...ids, decisionReason: 'invalid_request_state' });
        throw new ProtocolError(-32602, (err as Error).message);
      }
    }

    // 3 arguments against the pinned schema
    const schema = parseJsonColumn<Record<string, unknown>>(t.input_schema) ?? { type: 'object' };
    const check = this.d.args.check(t.pinned_hash, schema, args);
    if (!check.ok) {
      record('allowed', 'invalid_args', { ...ids, errorCode: 'invalid_args', errorMessage: check.errors.join('; ').slice(0, 1000) });
      return errorResult(`Invalid arguments for ${name}:\n- ${check.errors.join('\n- ')}`);
    }

    // 4 rate limits
    const tl = parseJsonColumn<{ perMinute: number; burst: number }>(t.rate_limit);
    const sl = parseJsonColumn<{ perToolPerMinute: number | null }>(t.server_rate_limit);
    const checks = await this.d.limiter.checksFor({ agentId: rc.principal.agent.id, agentLimit: rc.principal.agent.rateLimit, toolId: t.id, toolLimit: tl, serverPerToolPerMinute: sl?.perToolPerMinute ?? null });
    const rl = await this.d.limiter.take(checks);
    if (!rl.allowed) {
      const secs = Math.max(1, Math.ceil(rl.retryAfterMs / 1000));
      record('denied_rate_limit', 'blocked', { ...ids, decisionReason: rl.scope });
      return errorResult(`Rate limit exceeded for ${name}; retry after ${secs}s`, { [META_RETRY_AFTER_MS]: rl.retryAfterMs });
    }

    // 5 human approval: held across replicas until decided, expired or cancelled (§12.2)
    let decision: AuditDecision = 'allowed';
    if (toBool(t.requires_approval) && !upstreamState) {
      const out = await this.d.approvals.hold(rc, {
        requestId,
        toolId: t.id,
        serverId: t.server_id,
        toolName: name,
        args,
        timeoutSec: t.approval_timeout_sec,
        signal: ctx.mcpReq.signal,
        client: { name: info.clientName, version: info.clientVersion },
        // interim audit row: the call is held (not counted as a call by rollups/metrics)
        onPending: (a) => void this.d.audit.record({ ...base, kind: 'tool_call', toolName: name, decision: 'approval_pending', status: 'blocked', params, ...ids, decisionReason: `approval ${a.id} (timeout ${a.timeoutSec}s)` }),
        ...(info.progressToken !== undefined
          ? { progress: (p: { progress: number; total: number; message: string }) => void ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: info.progressToken!, ...p } }).catch(() => {}) }
          : {}),
      });
      if (out.status !== 'approved') {
        const map = { denied: 'approval_denied', timeout: 'approval_timeout', cancelled: 'approval_cancelled', unavailable: 'denied_disabled' } as const;
        record(map[out.status], out.status === 'cancelled' ? 'cancelled' : 'blocked', { ...ids, decisionReason: out.message.slice(0, 500) });
        return errorResult(out.message);
      }
      decision = 'approved';
    }

    // 6 upstream (pinned definition; client token never forwarded)
    const upstreamMeta: Record<string, unknown> = {};
    if (info.meta.progressToken !== undefined) upstreamMeta.progressToken = info.meta.progressToken;
    // forward the client's declared capabilities so a modern upstream can ask for input (MRTR)
    if (info.era === 'modern' && info.clientCaps) upstreamMeta[ENVELOPE_CAPS] = info.clientCaps;
    const upstreamStart = this.d.clock.now();
    let result;
    try {
      result = await trace.upstream(t.server_slug, (traceMeta) => this.d.pool.callTool(
        { id: t.server_id, name: t.server_name, url: t.url, transport: t.transport, authMode: t.auth_mode, timeoutMs: t.timeout_ms },
        rc.principal.user.id,
        {
          name: t.upstream_name,
          arguments: args,
          // gateway → upstream span context in the reserved _meta keys (§10.5)
          _meta: { ...upstreamMeta, ...traceMeta },
          ...(upstreamState ? { requestState: upstreamState.s, inputResponses: ctx.mcpReq.inputResponses ?? {} } : {}),
        } as never,
        {
          timeoutMs: Math.min(t.timeout_ms, MAX_CALL_TIMEOUT_MS),
          signal: ctx.mcpReq.signal,
          toolDefinition: { name: t.upstream_name, description: t.description, inputSchema: schema as never, ...(t.output_schema ? { outputSchema: parseJsonColumn(t.output_schema) as never } : {}) },
          ...(info.progressToken !== undefined
            ? { onprogress: (p: { progress: number; total?: number; message?: string }) => void ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: info.progressToken!, ...p } }).catch(() => {}) }
            : {}),
        },
      ));
    } catch (err) {
      const ue = err instanceof UpstreamError ? err : new UpstreamError('transport', (err as Error).message);
      const upstreamLatencyMs = this.d.clock.now() - upstreamStart;
      if (ue.kind === 'cancelled') {
        record(decision, 'cancelled', { ...ids, upstreamLatencyMs });
        throw err;
      }
      const status: AuditStatus = ue.kind === 'timeout' ? 'timeout' : 'upstream_error';
      record(decision, status, { ...ids, upstreamLatencyMs, errorCode: ue.kind, errorMessage: ue.message.slice(0, 500) });
      return errorResult(this.upstreamMessage(ue, t.server_name));
    }
    const upstreamLatencyMs = this.d.clock.now() - upstreamStart;

    // 7 shaping
    if ((result as { resultType?: string }).resultType === 'input_required') {
      const ir = result as { inputRequests?: Record<string, unknown>; requestState?: string };
      if (info.era !== 'modern' || !ir.inputRequests) {
        record(decision, 'tool_error', { ...ids, upstreamLatencyMs, errorCode: 'input_required_unsupported' });
        return errorResult("This tool needs interactive input that your client's protocol version can't provide");
      }
      record(decision, 'ok', { ...ids, upstreamLatencyMs, decisionReason: 'input_required' });
      return {
        resultType: 'input_required',
        inputRequests: ir.inputRequests,
        requestState: wrapRequestState(this.d.keyring, { s: ir.requestState ?? '', srv: t.server_id, tool: t.id, uid: rc.principal.user.id, aid: rc.principal.agent.id, exp: this.d.clock.now() + MRTR_TTL_MS }),
      };
    }
    const r = result as CallToolResult;
    const shaped: CallToolResult = { content: r.content ?? [], ...(r.structuredContent !== undefined ? { structuredContent: r.structuredContent } : {}), ...(r.isError ? { isError: true } : {}) };
    record(decision, r.isError ? 'tool_error' : 'ok', { ...ids, upstreamLatencyMs, output: shaped });
    return shaped;
  }

  private upstreamMessage(e: UpstreamError, serverName: string): string {
    switch (e.kind) {
      case 'circuit_open':
        return `Server ${serverName} is unavailable`;
      case 'timeout':
        return `Server ${serverName} did not respond in time`;
      case 'connect_required':
        return `Connect your ${serverName} account at ${this.d.publicUrl}/connections, then retry`;
      case 'auth_required':
        return `Server ${serverName} rejected the gateway's credentials; ask the server owner to update them`;
      default:
        return `Server ${serverName} returned an error: ${e.message.slice(0, 300)}`;
    }
  }
}
