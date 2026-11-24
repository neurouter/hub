import { EventEmitter } from 'node:events';
import { sql, type Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { MainDB } from '../db/schema.js';
import type { Clock } from '../lib/clock.js';
import type { CoordinationStore, Json, Unsubscribe, WaitForOptions } from './types.js';
import { waitForOn } from './wait.js';

export const PG_CHANNEL = 'neurouter_events';
/** NOTIFY payloads must stay under 8000 bytes. */
export const MAX_NOTIFY_BYTES = 7900;

/** The dedicated LISTEN connection (a pg.Client in production, a fake in tests). */
export interface ListenClient {
  connect(): Promise<unknown>;
  query(text: string): Promise<unknown>;
  on(event: 'notification', fn: (msg: { channel: string; payload?: string }) => void): unknown;
  on(event: 'error' | 'end', fn: (err?: Error) => void): unknown;
  end(): Promise<void>;
}

/**
 * Multi-replica coordination on Postgres (backend §12.1): LISTEN/NOTIFY fan-out with reconnect +
 * synthetic `resync`, table leases for job leadership, advisory transaction locks. NOTIFY only
 * cuts latency; `waitFor` always polls the DB too, so correctness survives PgBouncer
 * transaction pooling (R3).
 */
export class PostgresCoordination implements CoordinationStore {
  readonly backend = 'postgres' as const;
  private readonly local = new EventEmitter();
  private client: ListenClient | null = null;
  private closed = false;
  private retry = 0;

  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly clock: Clock,
    private readonly newListenClient: () => ListenClient,
    private readonly log: Pick<Logger, 'warn' | 'info'>,
    private readonly backoff = (n: number) => Math.min(30_000, 500 * 2 ** n),
  ) {
    this.local.setMaxListeners(0);
  }

  async start(): Promise<void> {
    if (this.closed) return;
    const c = this.newListenClient();
    c.on('notification', (msg) => {
      if (msg.channel !== PG_CHANNEL || !msg.payload) return;
      try {
        const { c: channel, p } = JSON.parse(msg.payload) as { c: string; p: Json };
        this.local.emit(channel, p);
      } catch {
        // ignore malformed payloads
      }
    });
    const onDown = (err?: Error) => {
      if (this.client !== c || this.closed) return;
      this.client = null;
      this.log.warn({ err }, 'coordination LISTEN connection lost; reconnecting');
      setTimeout(() => void this.start().catch(() => {}), this.backoff(this.retry++)).unref?.();
    };
    c.on('error', onDown);
    c.on('end', onDown);
    try {
      await c.connect();
      await c.query(`LISTEN ${PG_CHANNEL}`);
    } catch (err) {
      this.log.warn({ err }, 'coordination LISTEN failed; retrying');
      setTimeout(() => void this.start().catch(() => {}), this.backoff(this.retry++)).unref?.();
      return;
    }
    const reconnected = this.retry > 0;
    this.retry = 0;
    this.client = c;
    // caches may have missed events while we were disconnected
    if (reconnected) this.local.emit('resync', {});
  }

  async publish(channel: string, payload: Json): Promise<void> {
    const msg = JSON.stringify({ c: channel, p: payload });
    if (Buffer.byteLength(msg) > MAX_NOTIFY_BYTES) throw new Error(`coordination payload too large for NOTIFY (${channel})`);
    await sql`select pg_notify(${PG_CHANNEL}, ${msg})`.execute(this.db);
  }

  subscribe(channel: string, fn: (payload: Json) => void): Unsubscribe {
    this.local.on(channel, fn);
    return () => this.local.off(channel, fn);
  }

  waitFor(channel: string, predicate: (p: Json) => boolean, opts: WaitForOptions): Promise<Json | null> {
    return waitForOn((fn) => this.subscribe(channel, fn), predicate, opts);
  }

  async acquireLease(name: string, holder: string, ttlMs: number): Promise<boolean> {
    const now = this.clock.now();
    const r = await sql<{ holder: string }>`
      insert into leases (name, holder, expires_at) values (${name}, ${holder}, ${now + ttlMs})
      on conflict (name) do update set holder = excluded.holder, expires_at = excluded.expires_at
      where leases.expires_at < ${now} or leases.holder = ${holder}
      returning holder`.execute(this.db);
    return r.rows[0]?.holder === holder;
  }

  async releaseLease(name: string, holder: string): Promise<void> {
    await this.db.deleteFrom('leases').where('name', '=', name).where('holder', '=', holder).execute();
  }

  async withLock<T>(name: string, _ttlMs: number, fn: () => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtext(${name}))`.execute(trx);
      return fn();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const c = this.client;
    this.client = null;
    this.local.removeAllListeners();
    await c?.end().catch(() => {});
  }
}
