import type { CoordinationStore, Json } from '../coordination/types.js';

type RpcId = string | number;

/** What `/mcp` needs to know about a raw JSON-RPC body before the SDK sees it. */
export interface RpcInspection {
  /** ids of `tools/call` requests in the body */
  calls: RpcId[];
  /** `requestId`s named by `notifications/cancelled` */
  cancels: RpcId[];
  /** `initialize` params (legacy era: clientInfo is only sent here) */
  initialize: { name: string | null; version: string | null; protocolVersion: string | null } | null;
}

const isId = (v: unknown): v is RpcId => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null);

/** Parses a JSON-RPC message or batch; anything malformed is left for the SDK to reject. */
export function inspectJsonRpc(body: string | undefined): RpcInspection {
  const out: RpcInspection = { calls: [], cancels: [], initialize: null };
  if (!body) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return out;
  }
  for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
    if (!m || typeof m !== 'object') continue;
    const msg = m as { method?: unknown; id?: unknown; params?: Record<string, unknown> };
    const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
    if (msg.method === 'tools/call' && isId(msg.id)) out.calls.push(msg.id);
    else if (msg.method === 'notifications/cancelled' && isId(params.requestId)) out.cancels.push(params.requestId);
    else if (msg.method === 'initialize') {
      const ci = (params.clientInfo ?? {}) as Record<string, unknown>;
      out.initialize = { name: str(ci.name, 200), version: str(ci.version, 100), protocolVersion: str(params.protocolVersion, 64) };
    }
  }
  return out;
}

export const MCP_CANCEL_CHANNEL = 'mcp.cancel';

/**
 * In-flight `tools/call` requests by (credential, JSON-RPC id), so a `notifications/cancelled`
 * arriving on a separate POST (stateless `/mcp`) aborts the held call — including a pending
 * approval (backend §17 step 9). Cancels for calls held on another replica are relayed through
 * the coordination bus. Ids are only unique per client connection, so when one credential has
 * several in-flight calls with the same id (two processes sharing a key) the cancel is
 * ambiguous and ignored rather than aborting someone else's call.
 */
export class InflightCalls {
  private readonly byKey = new Map<string, Set<AbortController>>();

  constructor(private readonly coord?: CoordinationStore) {
    coord?.subscribe(MCP_CANCEL_CHANNEL, (p) => {
      const k = (p as { k?: unknown } | null)?.k;
      if (typeof k === 'string') this.abortLocal(k);
    });
  }

  private static key(credentialId: string, id: RpcId): string {
    return `${credentialId}\u0000${typeof id}:${String(id)}`;
  }

  get size(): number {
    let n = 0;
    for (const s of this.byKey.values()) n += s.size;
    return n;
  }

  /** Tracks `controller` until the returned release function is called. */
  register(credentialId: string, id: RpcId, controller: AbortController): () => void {
    const k = InflightCalls.key(credentialId, id);
    let set = this.byKey.get(k);
    if (!set) this.byKey.set(k, (set = new Set()));
    set.add(controller);
    return () => {
      const s = this.byKey.get(k);
      if (!s) return;
      s.delete(controller);
      if (s.size === 0) this.byKey.delete(k);
    };
  }

  /** 'local' when aborted here, 'relayed' when sent to other replicas, 'ambiguous' when skipped. */
  async cancel(credentialId: string, id: RpcId): Promise<'local' | 'relayed' | 'ambiguous'> {
    const k = InflightCalls.key(credentialId, id);
    const local = this.abortLocal(k);
    if (local !== 'none') return local;
    await this.coord?.publish(MCP_CANCEL_CHANNEL, { k } as Json);
    return 'relayed';
  }

  private abortLocal(k: string): 'local' | 'ambiguous' | 'none' {
    const set = this.byKey.get(k);
    if (!set || set.size === 0) return 'none';
    if (set.size > 1) return 'ambiguous';
    const [c] = set;
    c!.abort(new Error('cancelled by client'));
    return 'local';
  }
}

/**
 * Legacy (2025-11-25) clients send clientInfo only in `initialize`, and stateless `/mcp` builds a
 * fresh server per request, so later calls would audit `client = null`. This remembers the last
 * initialize per credential (and legacy session id when sent) for attribution. Bounded LRU.
 */
export class LegacyClientInfo {
  private readonly map = new Map<string, { name: string | null; version: string | null; protocolVersion: string | null; at: number }>();

  constructor(
    private readonly max = 10_000,
    private readonly ttlMs = 24 * 3_600_000,
    private readonly now: () => number = Date.now,
  ) {}

  private static key(credentialId: string, sessionId: string | null): string {
    return `${credentialId}\u0000${sessionId ?? ''}`;
  }

  remember(credentialId: string, sessionId: string | null, info: { name: string | null; version: string | null; protocolVersion: string | null }): void {
    const keys = sessionId ? [LegacyClientInfo.key(credentialId, sessionId), LegacyClientInfo.key(credentialId, null)] : [LegacyClientInfo.key(credentialId, null)];
    for (const k of keys) {
      this.map.delete(k);
      this.map.set(k, { ...info, at: this.now() });
    }
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }

  get(credentialId: string, sessionId: string | null): { name: string | null; version: string | null; protocolVersion: string | null } | null {
    const k = LegacyClientInfo.key(credentialId, sessionId);
    const hit = this.map.get(k) ?? (sessionId ? this.map.get(LegacyClientInfo.key(credentialId, null)) : undefined);
    if (!hit) return null;
    if (this.now() - hit.at > this.ttlMs) {
      this.map.delete(k);
      return null;
    }
    return { name: hit.name, version: hit.version, protocolVersion: hit.protocolVersion };
  }
}
