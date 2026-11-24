import type { CallToolResult, Tool } from '@modelcontextprotocol/client';
import type { PriorDiscovery } from '@modelcontextprotocol/client';
import type { Logger } from 'pino';
import type { Clock } from '../lib/clock.js';
import type { FetchLike } from '../lib/net/safe-fetch.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { connectUpstream, type ConnectedUpstream, type UpstreamEra, type UpstreamServerInfo } from './client-factory.js';
import { credentialIdentity, type AuthMode, type CredentialResolver } from './credentials.js';
import { classifyUpstreamError, UpstreamError } from './errors.js';

export interface UpstreamServer {
  id: string;
  name: string;
  url: string;
  transport: 'streamable_http' | 'sse';
  authMode: AuthMode;
  timeoutMs: number;
}

export interface EraInfo {
  era: UpstreamEra;
  protocolVersion: string | null;
  serverInfo: UpstreamServerInfo | null;
}

export interface PoolOptions {
  clock: Clock;
  credentials: CredentialResolver;
  /** Outbound fetch per server (safeFetchUpstream in prod, FakeUpstream.fetch in tests). */
  fetchFor: (server: UpstreamServer) => FetchLike;
  logger: Pick<Logger, 'debug' | 'warn'>;
  onEra?: (serverId: string, info: EraInfo) => void;
  onCircuit?: (serverId: string, open: boolean) => void;
  maxEntries?: number;
  idleMs?: number;
  connectTimeoutMs?: number;
}

/** Upper bound for any single upstream call (backend §6). */
export const MAX_CALL_TIMEOUT_MS = 600_000;

export type UpstreamCallResult = CallToolResult | { resultType: 'input_required'; inputRequests?: unknown; requestState?: string; [k: string]: unknown };

interface Entry {
  key: string;
  serverId: string;
  conn: Promise<ConnectedUpstream>;
  lastUsed: number;
}

/**
 * Upstream client pool (backend §6): one connected SDK client per (server, credential identity),
 * LRU-bounded with an idle TTL, per-server circuit breaker and cached era verdicts.
 */
export class UpstreamPool {
  private readonly entries = new Map<string, Entry>();
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly priors = new Map<string, PriorDiscovery>();
  private readonly maxEntries: number;
  private readonly idleMs: number;

  constructor(private readonly o: PoolOptions) {
    this.maxEntries = o.maxEntries ?? 2000;
    this.idleMs = o.idleMs ?? 600_000;
  }

  breaker(serverId: string): CircuitBreaker {
    let b = this.breakers.get(serverId);
    if (!b) this.breakers.set(serverId, (b = new CircuitBreaker(this.o.clock)));
    return b;
  }

  private async open(server: UpstreamServer, userId: string | null, timeoutMs: number): Promise<ConnectedUpstream> {
    const headers = await this.o.credentials.headersFor(server, userId);
    const prior = this.priors.get(server.id) ?? null;
    const conn = await connectUpstream({ url: server.url, transport: server.transport, headers }, this.o.fetchFor(server), { timeoutMs, prior });
    if (conn.prior) this.priors.set(server.id, conn.prior);
    this.o.onEra?.(server.id, { era: conn.era, protocolVersion: conn.protocolVersion, serverInfo: conn.serverInfo });
    return conn;
  }

  private sweep(): void {
    const now = this.o.clock.now();
    for (const [k, e] of this.entries) if (now - e.lastUsed > this.idleMs) this.drop(k);
    while (this.entries.size >= this.maxEntries) {
      const oldest = [...this.entries.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!oldest) break;
      this.drop(oldest.key);
    }
  }

  private drop(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    e.conn.then((c) => c.client.close()).catch(() => {});
  }

  private async get(server: UpstreamServer, userId: string | null): Promise<{ conn: ConnectedUpstream; key: string }> {
    const key = `${server.id}|${credentialIdentity(server.authMode, server.authMode === 'user_oauth' ? userId : null)}`;
    const now = this.o.clock.now();
    let e = this.entries.get(key);
    if (!e) {
      this.sweep();
      const conn = this.open(server, userId, Math.min(server.timeoutMs, this.o.connectTimeoutMs ?? 15_000));
      e = { key, serverId: server.id, conn, lastUsed: now };
      this.entries.set(key, e);
      conn.catch(() => {
        if (this.entries.get(key) === e) this.entries.delete(key);
      });
    }
    e.lastUsed = now;
    return { conn: await e.conn, key };
  }

  private guard(serverId: string, name: string): CircuitBreaker {
    const b = this.breaker(serverId);
    if (!b.tryAcquire()) throw new UpstreamError('circuit_open', `Server ${name} is unavailable`);
    return b;
  }

  private failed(serverId: string, key: string | null, err: UpstreamError): void {
    if (key) this.drop(key);
    if (err.kind === 'transport' || err.kind === 'timeout') {
      if (this.breaker(serverId).onFailure()) {
        this.o.onCircuit?.(serverId, true);
        this.o.logger.warn({ serverId }, 'upstream circuit opened');
      }
    } else if (err.kind !== 'cancelled') {
      // auth / protocol errors do not count against availability
      this.breaker(serverId).onSuccess();
    }
  }

  private succeeded(serverId: string): void {
    const b = this.breaker(serverId);
    const wasOpen = b.state !== 'closed';
    b.onSuccess();
    if (wasOpen) this.o.onCircuit?.(serverId, false);
  }

  /** Lists every page of tools. Idempotent, so a legacy session loss is retried once. */
  async listTools(server: UpstreamServer, userId: string | null, timeoutMs = 15_000): Promise<{ tools: Tool[]; era: EraInfo }> {
    this.guard(server.id, server.name);
    for (let attempt = 0; ; attempt++) {
      let key: string | null = null;
      const signal = AbortSignal.timeout(timeoutMs);
      try {
        const got = await this.get(server, userId);
        key = got.key;
        const res = await got.conn.client.listTools(undefined, { timeout: timeoutMs, signal });
        this.succeeded(server.id);
        return { tools: res.tools, era: { era: got.conn.era, protocolVersion: got.conn.protocolVersion, serverInfo: got.conn.serverInfo } };
      } catch (err) {
        const ue = classifyUpstreamError(err, signal);
        if (attempt === 0 && ue.kind === 'transport' && key) {
          this.drop(key);
          this.priors.delete(server.id); // re-probe: a cached assumption may have failed
          continue;
        }
        this.failed(server.id, key, ue);
        throw ue;
      }
    }
  }

  /** Calls a tool. Not retried once sent (backend §6). */
  async callTool(
    server: UpstreamServer,
    userId: string | null,
    params: { name: string; arguments: Record<string, unknown>; _meta?: Record<string, unknown> },
    opts: { timeoutMs: number; signal?: AbortSignal; toolDefinition?: Tool; onprogress?: (p: { progress: number; total?: number; message?: string }) => void },
  ): Promise<UpstreamCallResult> {
    this.guard(server.id, server.name);
    const timeoutMs = Math.min(opts.timeoutMs, MAX_CALL_TIMEOUT_MS);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let key: string | null = null;
    try {
      const got = await this.get(server, userId);
      key = got.key;
      const result = await got.conn.client.callTool(params, {
        timeout: timeoutMs,
        signal,
        ...(opts.toolDefinition ? { toolDefinition: opts.toolDefinition } : {}),
        ...(opts.onprogress ? { onprogress: opts.onprogress } : {}),
        allowInputRequired: true,
      } as never);
      this.succeeded(server.id);
      return result as UpstreamCallResult;
    } catch (err) {
      const ue = classifyUpstreamError(err, signal);
      this.failed(server.id, key, ue);
      throw ue;
    }
  }

  /** One-off connection (test-connection, health): not pooled, no breaker. */
  async probe(server: UpstreamServer & { headers?: Record<string, string> }, opts: { timeoutMs: number; listTools?: boolean }): Promise<EraInfo & { toolCount: number | null; tools?: Tool[] }> {
    const headers = server.headers ?? (await this.o.credentials.headersFor(server, null));
    const signal = AbortSignal.timeout(opts.timeoutMs);
    let conn: ConnectedUpstream | null = null;
    try {
      conn = await connectUpstream({ url: server.url, transport: server.transport, headers }, this.o.fetchFor(server), { timeoutMs: opts.timeoutMs, signal });
      const tools = opts.listTools ? (await conn.client.listTools(undefined, { timeout: opts.timeoutMs, signal })).tools : undefined;
      return { era: conn.era, protocolVersion: conn.protocolVersion, serverInfo: conn.serverInfo, toolCount: tools ? tools.length : null, ...(tools ? { tools } : {}) };
    } catch (err) {
      throw classifyUpstreamError(err, signal);
    } finally {
      await conn?.client.close().catch(() => {});
    }
  }

  /** Drops one user's pooled connection (their upstream token changed: reconnect with the new one). */
  dropIdentity(serverId: string, userId: string): void {
    this.drop(`${serverId}|${credentialIdentity('user_oauth', userId)}`);
    this.o.credentials.invalidate(serverId);
  }

  invalidate(serverId: string): void {
    for (const [k, e] of this.entries) if (e.serverId === serverId) this.drop(k);
    this.priors.delete(serverId);
    this.o.credentials.invalidate(serverId);
  }

  get size(): number {
    return this.entries.size;
  }

  async close(): Promise<void> {
    for (const k of [...this.entries.keys()]) this.drop(k);
  }
}
