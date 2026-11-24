import type { Kysely, Transaction } from 'kysely';
import type { AuditDB } from '../db/schema.js';
import { newId } from '../lib/ids.js';
import { parseJsonColumn, toJsonColumn } from '../lib/json.js';

/**
 * Session derivation (backend §10.3). The gateway computes a session *key* per MCP request
 * (`gateway/call-pipeline.ts sessionKeyOf`: client `_meta` id → trace id → legacy header →
 * idle gap); this module resolves the key to an `mcp_sessions` row INSIDE the audit flush
 * transaction (holding the PG audit lock or the SQLite write transaction), so idle-gap reuse is
 * race-free across replicas. Sessions are always scoped by agent (the unique key includes it).
 */
export type SessionSourceKind = 'client' | 'trace' | 'legacy' | 'idle_gap';

export interface SessionEventInput {
  ts: number;
  kind: string;
  agentId: string | null;
  userId: string | null;
  clientName: string | null;
  serverId: string | null;
  status: string;
  /** Interim `approval_pending` rows don't count as calls. */
  decision?: string;
  sessionKey: { source: SessionSourceKind; externalKey: string } | null | undefined;
}

export const LIVE_SESSION_MS = 5 * 60_000;
export const MAX_SESSION_SERVERS = 50;
const ERROR_STATUSES = new Set(['tool_error', 'upstream_error', 'timeout', 'invalid_args']);

interface Delta {
  id: string;
  calls: number;
  errors: number;
  blocked: number;
  firstSeen: number;
  lastSeen: number;
  servers: Set<string>;
  clientName: string | null;
}

type Db = Kysely<AuditDB> | Transaction<AuditDB>;

export class SessionResolver {
  /** (agent|source|key) → session id, for non-idle sources (ids never change once created). */
  private readonly cache = new Map<string, string>();
  /** agent → last idle-gap session seen by this replica. */
  private readonly idle = new Map<string, { id: string; lastSeen: number }>();

  constructor(private readonly maxCache = 10_000) {}

  /** Drops cached ids (retention deleted old sessions). */
  clear(): void {
    this.cache.clear();
    this.idle.clear();
  }

  private remember(k: string, id: string): void {
    if (this.cache.size >= this.maxCache) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(k, id);
  }

  /**
   * Resolves session ids for a batch (in order) and applies counter deltas. Returns one id (or
   * null for events that are not MCP traffic) per input event.
   */
  async resolveBatch(db: Db, events: readonly SessionEventInput[], idleMs: number): Promise<(string | null)[]> {
    const out: (string | null)[] = [];
    const deltas = new Map<string, Delta>();
    const created = new Set<string>();
    for (const e of events) {
      if (!e.agentId || !e.userId || !e.sessionKey || !['tool_call', 'tool_search', 'tools_list'].includes(e.kind)) {
        out.push(null);
        continue;
      }
      const id = await this.resolveOne(db, e, idleMs, deltas, created);
      out.push(id);
      let d = deltas.get(id);
      if (!d) {
        d = { id, calls: 0, errors: 0, blocked: 0, firstSeen: e.ts, lastSeen: e.ts, servers: new Set(), clientName: e.clientName };
        deltas.set(id, d);
      }
      if (e.kind === 'tool_call' && e.decision !== 'approval_pending') {
        d.calls++;
        if (ERROR_STATUSES.has(e.status)) d.errors++;
        if (e.status === 'blocked') d.blocked++;
      }
      d.lastSeen = Math.max(d.lastSeen, e.ts);
      d.firstSeen = Math.min(d.firstSeen, e.ts);
      if (e.serverId) d.servers.add(e.serverId);
      d.clientName ??= e.clientName;
    }
    for (const d of deltas.values()) await this.apply(db, d);
    return out;
  }

  private async resolveOne(db: Db, e: SessionEventInput, idleMs: number, pending: Map<string, Delta>, created: Set<string>): Promise<string> {
    const key = e.sessionKey!;
    const agentId = e.agentId!;
    if (key.source === 'idle_gap') {
      // an idle-gap session created or extended earlier in this batch
      const local = this.idle.get(agentId);
      if (local && e.ts - (pending.get(local.id)?.lastSeen ?? local.lastSeen) <= idleMs && (pending.has(local.id) || created.has(local.id))) {
        local.lastSeen = Math.max(local.lastSeen, e.ts);
        return local.id;
      }
      const row = await db
        .selectFrom('mcp_sessions')
        .select(['id', 'last_seen_at'])
        .where('agent_id', '=', agentId)
        .where('source', '=', 'idle_gap')
        .where('last_seen_at', '>=', e.ts - idleMs)
        .orderBy('last_seen_at', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (row) {
        this.idle.set(agentId, { id: row.id, lastSeen: Math.max(Number(row.last_seen_at), e.ts) });
        created.add(row.id);
        return row.id;
      }
      const id = newId();
      await db
        .insertInto('mcp_sessions')
        .values({ id, source: 'idle_gap', external_key: id, agent_id: agentId, user_id: e.userId!, client_name: e.clientName, first_seen_at: e.ts, last_seen_at: e.ts, servers: '[]' })
        .execute();
      this.idle.set(agentId, { id, lastSeen: e.ts });
      created.add(id);
      return id;
    }
    const ck = `${agentId}|${key.source}|${key.externalKey}`;
    const cached = this.cache.get(ck);
    if (cached) {
      // the row may have been pruned by retention since; re-create it under the same id
      const exists = pending.has(cached) || created.has(cached) || (await db.selectFrom('mcp_sessions').select('id').where('id', '=', cached).executeTakeFirst());
      if (exists) return cached;
      this.cache.delete(ck);
    }
    const row = await db.selectFrom('mcp_sessions').select('id').where('source', '=', key.source).where('external_key', '=', key.externalKey).where('agent_id', '=', agentId).executeTakeFirst();
    let id = row?.id;
    if (!id) {
      id = newId();
      await db
        .insertInto('mcp_sessions')
        .values({ id, source: key.source, external_key: key.externalKey, agent_id: agentId, user_id: e.userId!, client_name: e.clientName, first_seen_at: e.ts, last_seen_at: e.ts, servers: '[]' })
        .execute();
      created.add(id);
    }
    this.remember(ck, id);
    return id;
  }

  private async apply(db: Db, d: Delta): Promise<void> {
    const cur = await db.selectFrom('mcp_sessions').select(['servers', 'client_name', 'last_seen_at', 'first_seen_at']).where('id', '=', d.id).executeTakeFirst();
    if (!cur) return;
    const servers = new Set(parseJsonColumn<string[]>(cur.servers) ?? []);
    for (const s of d.servers) if (servers.size < MAX_SESSION_SERVERS) servers.add(s);
    await db
      .updateTable('mcp_sessions')
      .set((eb) => ({
        calls: eb('calls', '+', d.calls),
        errors: eb('errors', '+', d.errors),
        blocked: eb('blocked', '+', d.blocked),
        last_seen_at: Math.max(Number(cur.last_seen_at), d.lastSeen),
        first_seen_at: Math.min(Number(cur.first_seen_at), d.firstSeen),
        servers: toJsonColumn([...servers]),
        client_name: cur.client_name ?? d.clientName,
      }))
      .where('id', '=', d.id)
      .execute();
  }
}
