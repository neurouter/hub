import { sql, type Kysely } from 'kysely';
import type { AuditDB } from '../db/schema.js';
import type { Dialect } from '../db/url.js';
import { systemClock, type Clock } from '../lib/clock.js';
import type { ArchiveStore } from './archive/store.js';
import { auditMacKey } from './chain.js';
import { maybePeriodicCheckpoint, toCheckpoint, writeCheckpoint, type MacSigner } from './checkpoints.js';
import { ensurePartitions } from './partitions.js';
import { countCapped, countsByMinute, decisionCounts, queryRows, streamRows } from './query.js';
import { applyRetention } from './retention.js';
import type { AuditCheckpoint, AuditEventInput, AuditQuery, AuditRow, AuditStats, AuditVerifyOutcome, DecisionCount, RetentionOutcome } from './types.js';
import { verifyChain } from './verify.js';
import { AuditWriter, DEFAULT_WRITE_CONTEXT, type AuditWriteContext, type AuditWriterHooks, type CommittedAuditRow } from './writer.js';
import type { CheckpointKind } from './chain.js';

export type * from './types.js';

/**
 * AuditStore (approved addendum 1): writer, query, export, verify and retention all go through
 * this interface. Nothing outside `audit/` touches `audit_log` directly. Phase 1 ships the SQL
 * implementation on the audit Kysely instance (AUDIT_DATABASE_URL); Phase 2 adds ClickHouse.
 */
export interface AuditStore {
  readonly backend: 'sql' | 'clickhouse';
  /** Non-blocking enqueue. False when the event was refused (queue full and fail-closed). */
  record(event: AuditEventInput): boolean;
  /** False when new tool calls must fail closed (audit can't keep up). */
  canAccept(): boolean;
  /** Flush queued events (shutdown, tests). */
  flush(deadlineMs?: number): Promise<void>;
  query(q: AuditQuery): Promise<{ rows: AuditRow[]; nextSeq: number | null }>;
  get(id: string): Promise<AuditRow | null>;
  export(q: Omit<AuditQuery, 'limit' | 'cursorSeq'>, maxRows: number): AsyncIterable<AuditRow>;
  /** Matching rows, counted up to `cap + 1` (export truncation). */
  count(q: Omit<AuditQuery, 'limit' | 'cursorSeq' | 'order'>, cap: number): Promise<number>;
  /** Blocked/decision counts (metrics breakdown `block_reason`). */
  decisionCounts(q: Omit<AuditQuery, 'limit' | 'cursorSeq' | 'order'>): Promise<DecisionCount[]>;
  /** Calls per minute (session detail). */
  countsByMinute(q: Omit<AuditQuery, 'limit' | 'cursorSeq' | 'order'>): Promise<{ t: number; calls: number }[]>;
  /** seq range covering a time range (verify by time). */
  seqRange(from?: number, to?: number): Promise<{ fromSeq?: number; toSeq?: number } | null>;
  verify(range: { fromSeq?: number; toSeq?: number }, onProgress?: (checked: number) => void | Promise<void>): Promise<AuditVerifyOutcome>;
  checkpoint(kind: CheckpointKind): Promise<AuditCheckpoint | null>;
  periodicCheckpoint(): Promise<AuditCheckpoint | null>;
  /** Rows after `seq` in order (sink dispatcher), plus checkpoints in that seq range. */
  readAfter(seq: number, limit: number): Promise<{ rows: AuditRow[]; checkpoints: AuditCheckpoint[] }>;
  headSeq(): Promise<number>;
  applyRetention(cutoff: number): Promise<RetentionOutcome>;
  /** Postgres: create upcoming daily partitions (no-op on SQLite). */
  maintainPartitions(): Promise<{ created: string[]; failed: { name: string; error: string }[] }>;
  stats(): AuditStats;
  /** Liveness of the underlying store (readiness probe). */
  health(): Promise<{ ok: boolean; error?: string }>;
  close(deadlineMs?: number): Promise<void>;
}

export interface SqlAuditStoreOptions {
  clock?: Clock;
  log?: { info(o: object, m: string): void; warn(o: object, m: string): void; error(o: object, m: string): void };
  /** Runtime settings for each flush (redaction rules, FTS param keys, full output, session idle, install id). */
  context?: () => Promise<AuditWriteContext>;
  enrich?: (events: AuditEventInput[]) => Promise<void>;
  /** Setting `auditFailClosed` (default true). Read synchronously; refresh it in `context()`. */
  failClosed?: () => boolean;
  /** Setting `auditFtsEnabled` (default true). */
  ftsEnabled?: () => boolean;
  /** Checkpoint MAC: active signer + key lookup by key id (KEK-derived). */
  mac?: { signer: () => MacSigner; keyFor: (keyId: string) => Buffer | null };
  archive?: ArchiveStore | null;
  onCommitted?: (rows: CommittedAuditRow[]) => void;
  hooks?: AuditWriterHooks;
  queueMax?: number;
  batchMax?: number;
  flushIntervalMs?: number;
}

const NOOP_LOG = { info: () => {}, warn: () => {}, error: () => {} };
/** Test/dev fallback MAC key when no keyring is wired (never used by createServices). */
const FALLBACK_MAC: MacSigner = { keyId: 'none', key: auditMacKey(Buffer.alloc(32)) };

export class SqlAuditStore implements AuditStore {
  readonly backend = 'sql' as const;
  private readonly writer: AuditWriter;
  private readonly clock: Clock;
  private readonly o: SqlAuditStoreOptions;
  private installId = DEFAULT_WRITE_CONTEXT.installId;

  constructor(
    private readonly db: Kysely<AuditDB>,
    readonly dialect: Dialect,
    opts: SqlAuditStoreOptions = {},
  ) {
    this.o = opts;
    this.clock = opts.clock ?? systemClock;
    const log = opts.log ?? NOOP_LOG;
    this.writer = new AuditWriter({
      db,
      dialect,
      clock: this.clock,
      log,
      context: async () => {
        const ctx = opts.context ? await opts.context() : DEFAULT_WRITE_CONTEXT;
        this.installId = ctx.installId;
        return ctx;
      },
      ...(opts.enrich ? { enrich: opts.enrich } : {}),
      failClosed: opts.failClosed ?? (() => true),
      ...(opts.onCommitted ? { onCommitted: opts.onCommitted } : {}),
      ...(opts.hooks ? { hooks: opts.hooks } : {}),
      ...(opts.queueMax !== undefined ? { queueMax: opts.queueMax } : {}),
      ...(opts.batchMax !== undefined ? { batchMax: opts.batchMax } : {}),
      ...(opts.flushIntervalMs !== undefined ? { flushIntervalMs: opts.flushIntervalMs } : {}),
    });
  }

  private get log() {
    return this.o.log ?? NOOP_LOG;
  }
  private signer(): MacSigner {
    return this.o.mac?.signer() ?? FALLBACK_MAC;
  }
  private keyFor(keyId: string): Buffer | null {
    if (this.o.mac) return this.o.mac.keyFor(keyId);
    return keyId === FALLBACK_MAC.keyId ? FALLBACK_MAC.key : null;
  }
  private async currentInstallId(): Promise<string> {
    if (this.o.context) this.installId = (await this.o.context()).installId;
    return this.installId;
  }
  private fts(): boolean {
    return this.o.ftsEnabled ? this.o.ftsEnabled() : true;
  }

  record(event: AuditEventInput): boolean {
    return this.writer.record(event);
  }
  canAccept(): boolean {
    return this.writer.canAccept();
  }
  flush(deadlineMs?: number): Promise<void> {
    return this.writer.flush(deadlineMs);
  }
  close(deadlineMs?: number): Promise<void> {
    return this.writer.close(deadlineMs);
  }

  query(q: AuditQuery): Promise<{ rows: AuditRow[]; nextSeq: number | null }> {
    return queryRows(this.db, this.dialect, q, this.fts());
  }

  async get(id: string): Promise<AuditRow | null> {
    return ((await this.db.selectFrom('audit_log').selectAll().where('id', '=', id).executeTakeFirst()) as AuditRow | undefined) ?? null;
  }

  export(q: Omit<AuditQuery, 'limit' | 'cursorSeq'>, maxRows: number): AsyncIterable<AuditRow> {
    return streamRows(this.db, this.dialect, q, maxRows, 1000, this.fts());
  }

  count(q: Omit<AuditQuery, 'limit' | 'cursorSeq' | 'order'>, cap: number): Promise<number> {
    return countCapped(this.db, this.dialect, q, cap, this.fts());
  }

  decisionCounts(q: Omit<AuditQuery, 'limit' | 'cursorSeq' | 'order'>): Promise<DecisionCount[]> {
    return decisionCounts(this.db, this.dialect, q);
  }

  countsByMinute(q: Omit<AuditQuery, 'limit' | 'cursorSeq' | 'order'>): Promise<{ t: number; calls: number }[]> {
    return countsByMinute(this.db, this.dialect, q);
  }

  async seqRange(from?: number, to?: number): Promise<{ fromSeq?: number; toSeq?: number } | null> {
    const out: { fromSeq?: number; toSeq?: number } = {};
    if (from !== undefined) {
      const r = await this.db.selectFrom('audit_log').select('seq').where('ts', '>=', from).orderBy('seq', 'asc').limit(1).executeTakeFirst();
      if (!r) return null;
      out.fromSeq = Number(r.seq);
    }
    if (to !== undefined) {
      const r = await this.db.selectFrom('audit_log').select('seq').where('ts', '<', to).orderBy('seq', 'desc').limit(1).executeTakeFirst();
      if (!r) return null;
      out.toSeq = Number(r.seq);
    }
    return out;
  }

  async verify(range: { fromSeq?: number; toSeq?: number }, onProgress?: (checked: number) => void | Promise<void>): Promise<AuditVerifyOutcome> {
    return verifyChain({ db: this.db, installId: await this.currentInstallId(), macKeyFor: (k) => this.keyFor(k), ...(onProgress ? { onProgress } : {}) }, range);
  }

  checkpoint(kind: CheckpointKind): Promise<AuditCheckpoint | null> {
    return writeCheckpoint(this.db, kind, this.signer(), this.clock.now());
  }

  periodicCheckpoint(): Promise<AuditCheckpoint | null> {
    return maybePeriodicCheckpoint(this.db, this.signer(), this.clock.now());
  }

  async readAfter(seq: number, limit: number): Promise<{ rows: AuditRow[]; checkpoints: AuditCheckpoint[] }> {
    const rows = (await this.db.selectFrom('audit_log').selectAll().where('seq', '>', seq).orderBy('seq', 'asc').limit(limit).execute()) as AuditRow[];
    if (!rows.length) return { rows, checkpoints: [] };
    const hi = Number(rows[rows.length - 1]!.seq);
    const cps = await this.db.selectFrom('audit_checkpoints').selectAll().where('seq', '>', seq).where('seq', '<=', hi).orderBy('seq', 'asc').execute();
    return { rows, checkpoints: cps.map((c) => toCheckpoint(c)) };
  }

  async headSeq(): Promise<number> {
    const r = await this.db.selectFrom('audit_log').select('seq').orderBy('seq', 'desc').limit(1).executeTakeFirst();
    return r ? Number(r.seq) : 0;
  }

  async applyRetention(cutoff: number): Promise<RetentionOutcome> {
    await this.writer.flush(10_000);
    const out = await applyRetention({ db: this.db, dialect: this.dialect, signer: this.signer(), now: () => this.clock.now(), archive: this.o.archive ?? null, log: this.log }, cutoff);
    if (out.sessionsDeleted) this.writer.resetSessionCache();
    return out;
  }

  async maintainPartitions(): Promise<{ created: string[]; failed: { name: string; error: string }[] }> {
    if (this.dialect !== 'postgres') return { created: [], failed: [] };
    return ensurePartitions(this.db, this.clock.now());
  }

  stats(): AuditStats {
    return { queueDepth: this.writer.depth, dropped: this.writer.droppedTotal, lastError: this.writer.lastError };
  }

  async health(): Promise<{ ok: boolean; error?: string }> {
    try {
      await sql`select count(*) from audit_sink_cursors`.execute(this.db);
      return this.writer.lastError ? { ok: false, error: `audit flush failing: ${this.writer.lastError}` } : { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}
