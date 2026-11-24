import { sql, type Kysely, type Transaction } from 'kysely';
import type { AuditDB, AuditLogTable } from '../db/schema.js';
import type { Dialect } from '../db/url.js';
import type { Clock } from '../lib/clock.js';
import { hashCanonical } from '../lib/jcs.js';
import { toJsonColumn } from '../lib/json.js';
import { SessionResolver } from '../observability/sessions.js';
import { genesisPrev, hashRow } from './chain.js';
import { paramsText, Redactor } from './redact.js';
import type { AuditEventInput } from './types.js';

/** Per-flush configuration (runtime settings), resolved before the write transaction. */
export interface AuditWriteContext {
  redactor: Redactor;
  /** Param keys whose (redacted) values feed the bounded FTS (`*` = all). */
  searchParamKeys: readonly string[];
  storeFullOutput: boolean;
  fullOutputMaxBytes: number;
  sessionIdleMs: number;
  installId: string;
}

export const DEFAULT_WRITE_CONTEXT: AuditWriteContext = {
  redactor: Redactor.builtins(),
  searchParamKeys: ['*'],
  storeFullOutput: false,
  fullOutputMaxBytes: 65_536,
  sessionIdleMs: 30 * 60_000,
  installId: 'default',
};

/** A committed row (what the chain covers) plus fields producers need after commit. */
export type CommittedAuditRow = AuditLogTable;

export interface AuditWriterHooks {
  queueDepth?(n: number): void;
  dropped?(): void;
  flushed?(seconds: number, rows: number): void;
}

export interface AuditWriterOptions {
  db: Kysely<AuditDB>;
  dialect: Dialect;
  clock: Clock;
  log: { warn(o: object, m: string): void; error(o: object, m: string): void };
  context: () => Promise<AuditWriteContext>;
  /** Fills derived fields before redaction (e.g. server_id of admin events on tools/grants). */
  enrich?: (events: AuditEventInput[]) => Promise<void>;
  failClosed: () => boolean;
  onCommitted?: (rows: CommittedAuditRow[]) => void;
  hooks?: AuditWriterHooks;
  queueMax?: number;
  batchMax?: number;
  flushIntervalMs?: number;
}

/** pg_advisory_xact_lock key for the audit chain ("NRAUDIT" as a 64-bit int). */
export const AUDIT_LOCK_ID = 0x4e5241554449_54n;

type Db = Kysely<AuditDB> | Transaction<AuditDB>;

/** Last chained (seq, hash): the newest row, else the newest checkpoint (all rows pruned), else genesis. */
export async function chainHead(db: Db, installId: string): Promise<{ seq: number; hash: string }> {
  const last = await db.selectFrom('audit_log').select(['seq', 'hash']).orderBy('seq', 'desc').limit(1).executeTakeFirst();
  if (last) return { seq: Number(last.seq), hash: last.hash };
  const cp = await db.selectFrom('audit_checkpoints').select(['seq', 'hash']).orderBy('seq', 'desc').limit(1).executeTakeFirst();
  if (cp) return { seq: Number(cp.seq), hash: cp.hash };
  return { seq: 0, hash: genesisPrev(installId) };
}

/**
 * Batching hash-chain writer (backend §9.1). `record()` never blocks: events go into a bounded
 * queue (10k). The flusher runs every 200 ms or 200 events: redact → resolve sessions → assign
 * contiguous `seq` and chain hashes under the audit lock (PG advisory xact lock / SQLite write
 * transaction) → insert (+ FTS5 rows on SQLite). A failed flush puts the batch back.
 */
export class AuditWriter {
  private queue: AuditEventInput[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private closed = false;
  private readonly sessions = new SessionResolver();
  private readonly queueMax: number;
  private readonly batchMax: number;
  private readonly intervalMs: number;
  droppedTotal = 0;
  lastError: string | null = null;

  constructor(private readonly o: AuditWriterOptions) {
    this.queueMax = o.queueMax ?? 10_000;
    this.batchMax = o.batchMax ?? 200;
    this.intervalMs = o.flushIntervalMs ?? 200;
  }

  get depth(): number {
    return this.queue.length;
  }

  /** False when new tool calls must fail closed (queue full and `auditFailClosed`). */
  canAccept(): boolean {
    return this.queue.length < this.queueMax || !this.o.failClosed();
  }

  record(e: AuditEventInput): boolean {
    if (this.queue.length >= this.queueMax) {
      this.droppedTotal++;
      this.o.hooks?.dropped?.();
      return !this.o.failClosed();
    }
    this.queue.push(e);
    this.o.hooks?.queueDepth?.(this.queue.length);
    if (this.queue.length >= this.batchMax) void this.flushSoon(0);
    else void this.flushSoon(this.intervalMs);
    return true;
  }

  private flushSoon(delay: number): void {
    if (this.closed) return;
    if (delay === 0) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      void this.flush().catch(() => {});
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch(() => {});
    }, delay);
    this.timer.unref?.();
  }

  /** Flushes everything queued (in batches). Resolves when the queue is empty or a batch fails. */
  async flush(deadlineMs?: number): Promise<void> {
    const until = deadlineMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + deadlineMs;
    while (this.flushing) await this.flushing;
    while (this.queue.length && Date.now() < until) {
      const batch = this.queue.splice(0, this.batchMax);
      this.flushing = this.writeBatch(batch)
        .then(() => {
          this.lastError = null;
        })
        .catch((err: unknown) => {
          this.lastError = (err as Error).message;
          this.o.log.error({ err, rows: batch.length }, 'audit flush failed; batch re-queued');
          this.queue.unshift(...batch.slice(0, Math.max(0, this.queueMax - this.queue.length)));
          throw err;
        })
        .finally(() => {
          this.flushing = null;
          this.o.hooks?.queueDepth?.(this.queue.length);
        });
      try {
        await this.flushing;
      } catch {
        // retry on the next tick (keeps ordering; fail-closed kicks in when the queue fills up)
        if (!this.closed) this.flushSoon(Math.max(this.intervalMs, 1000));
        return;
      }
    }
  }

  /** Stops the timer and flushes with a deadline (shutdown: 10 s). */
  async close(deadlineMs = 10_000): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.flush(deadlineMs);
    this.closed = true;
  }

  /** Clears cached session ids (after retention pruned sessions). */
  resetSessionCache(): void {
    this.sessions.clear();
  }

  private prepare(e: AuditEventInput, ctx: AuditWriteContext): Omit<AuditLogTable, 'seq' | 'prev_hash' | 'hash' | 'session_id'> {
    const params = e.params === undefined || e.params === null ? null : ctx.redactor.redact(e.params).value;
    const changes = e.changes ? ctx.redactor.redact({ before: e.changes.before ?? null, after: e.changes.after ?? null }).value : null;
    let outputSize: number | null = null;
    let outputHash: string | null = null;
    let outputFull: unknown = null;
    if (e.output !== undefined && e.output !== null) {
      const json = JSON.stringify(e.output);
      outputSize = Buffer.byteLength(json, 'utf8');
      try {
        outputHash = hashCanonical(e.output);
      } catch {
        outputHash = null;
      }
      if (ctx.storeFullOutput && outputSize <= ctx.fullOutputMaxBytes) outputFull = ctx.redactor.redact(e.output).value;
    }
    const s = (v: string | null | undefined, max = 2000) => (v === undefined || v === null ? null : v.slice(0, max));
    return {
      id: e.id,
      ts: e.ts,
      kind: e.kind,
      request_id: e.requestId ?? null,
      user_id: e.userId ?? null,
      agent_id: e.agentId ?? null,
      api_key_id: e.apiKeyId ?? null,
      oauth_client_id: e.oauthClientId ?? null,
      client_name: s(e.clientName, 200),
      client_version: s(e.clientVersion, 100),
      protocol_version: s(e.protocolVersion, 40),
      client_era: s(e.clientEra, 20),
      server_id: e.serverId ?? null,
      tool_id: e.toolId ?? null,
      tool_name: s(e.toolName, 300),
      action: s(e.action, 200),
      target_type: s(e.targetType, 50),
      target_id: s(e.targetId, 200),
      decision: e.decision,
      decision_reason: s(e.decisionReason, 1000),
      status: e.status,
      params_redacted: params === null ? null : toJsonColumn(params),
      params_text: params === null ? null : paramsText(params, ctx.searchParamKeys),
      changes: changes === null ? null : toJsonColumn(changes),
      output_size: outputSize,
      output_hash: outputHash,
      output_full: outputFull === null ? null : toJsonColumn(outputFull),
      latency_ms: e.latencyMs === undefined || e.latencyMs === null ? null : Math.max(0, Math.round(e.latencyMs)),
      upstream_latency_ms: e.upstreamLatencyMs === undefined || e.upstreamLatencyMs === null ? null : Math.max(0, Math.round(e.upstreamLatencyMs)),
      error_code: s(e.errorCode, 100),
      error_message: s(e.errorMessage, 2000),
      trace_id: s(e.traceId, 64),
      span_id: s(e.spanId, 32),
      ip: s(e.ip, 100),
      user_agent: s(e.userAgent, 512),
    };
  }

  private async writeBatch(batch: AuditEventInput[]): Promise<void> {
    const started = performance.now();
    if (this.o.enrich) await this.o.enrich(batch);
    const ctx = await this.o.context();
    const prepared = batch.map((e) => this.prepare(e, ctx));
    const committed: AuditLogTable[] = [];
    await this.o.db.transaction().execute(async (trx) => {
      if (this.o.dialect === 'postgres') await sql`select pg_advisory_xact_lock(${sql.lit(AUDIT_LOCK_ID.toString())}::bigint)`.execute(trx);
      const head = await chainHead(trx, ctx.installId);
      const sessionIds = await this.sessions.resolveBatch(
        trx,
        batch.map((e) => ({ ts: e.ts, kind: e.kind, agentId: e.agentId ?? null, userId: e.userId ?? null, clientName: e.clientName ?? null, serverId: e.serverId ?? null, status: e.status, decision: e.decision, sessionKey: e.sessionKey })),
        ctx.sessionIdleMs,
      );
      let prev = head.hash;
      let seq = head.seq;
      for (let i = 0; i < prepared.length; i++) {
        seq++;
        const row = { ...prepared[i]!, seq, session_id: sessionIds[i] ?? null, prev_hash: prev } as AuditLogTable;
        row.hash = hashRow(prev, row as unknown as Record<string, unknown>);
        prev = row.hash;
        committed.push(row);
      }
      // chunk inserts to stay under SQLite's bound-parameter limit (~40 columns per row)
      for (let i = 0; i < committed.length; i += 50) {
        const chunk = committed.slice(i, i + 50);
        await trx.insertInto('audit_log').values(chunk).execute();
        if (this.o.dialect === 'sqlite') {
          for (const r of chunk) {
            await sql`insert into audit_fts(rowid, params_text, tool_name, error_message, decision_reason) values (${r.seq}, ${r.params_text}, ${r.tool_name}, ${r.error_message}, ${r.decision_reason})`.execute(trx);
          }
        }
      }
    });
    this.o.hooks?.flushed?.((performance.now() - started) / 1000, committed.length);
    try {
      this.o.onCommitted?.(committed);
    } catch (err) {
      this.o.log.warn({ err }, 'audit post-commit hook failed');
    }
  }
}
