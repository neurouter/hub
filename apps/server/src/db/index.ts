import { sql, type Kysely } from 'kysely';
import type Database from 'better-sqlite3';
import type pg from 'pg';
import type { AuditDB, MainDB } from './schema.js';
import { createSqliteKysely, openSqlite, sqliteVersions } from './sqlite.js';
import { createPostgres, type PoolFactory } from './postgres.js';
import { parseDatabaseUrl, type Dialect } from './url.js';
import { migrateToLatest } from './migrator.js';
import type { MigrationContext } from './migrations/types.js';

export interface DbHandle<DB> {
  db: Kysely<DB>;
  dialect: Dialect;
  /** Native handle (better-sqlite3 Database or pg Pool). */
  native: { kind: 'sqlite'; database: Database.Database } | { kind: 'postgres'; pool: pg.Pool };
  close(): Promise<void>;
}

export interface Databases {
  /** Control plane (DATABASE_URL). */
  main: DbHandle<MainDB>;
  /** Audit, sessions, rollups (AUDIT_DATABASE_URL, defaults to the same instance as `main`). */
  audit: DbHandle<AuditDB>;
  /** True when audit uses its own connection/pool. */
  separateAudit: boolean;
  close(): Promise<void>;
}

export interface CreateDatabasesOptions {
  databaseUrl: string;
  auditDatabaseUrl?: string;
  poolMax?: number;
  auditPoolMax?: number;
  /** Base directory for relative sqlite paths (default cwd). */
  baseDir?: string;
  poolFactory?: PoolFactory;
  onWarn?: (msg: string, err?: unknown) => void;
}

export function openDatabase<DB>(url: string, opts: { poolMax?: number; baseDir?: string; poolFactory?: PoolFactory; onWarn?: (m: string, e?: unknown) => void; applicationName?: string } = {}): DbHandle<DB> {
  const target = parseDatabaseUrl(url, opts.baseDir);
  if (target.dialect === 'sqlite') {
    const database = openSqlite({ filename: target.filename });
    const db = createSqliteKysely<DB>(database);
    return { db, dialect: 'sqlite', native: { kind: 'sqlite', database }, close: () => db.destroy() };
  }
  const deps: { poolFactory?: PoolFactory; onWarn?: (m: string, e?: unknown) => void } = {};
  if (opts.poolFactory) deps.poolFactory = opts.poolFactory;
  if (opts.onWarn) deps.onWarn = opts.onWarn;
  const { db, pool } = createPostgres<DB>({ connectionString: target.connectionString, max: opts.poolMax ?? 20, ...(opts.applicationName ? { applicationName: opts.applicationName } : {}) }, deps);
  return { db, dialect: 'postgres', native: { kind: 'postgres', pool }, close: () => db.destroy() };
}

/**
 * Opens the control-plane DB and the audit DB. When AUDIT_DATABASE_URL is unset or equal to
 * DATABASE_URL, both handles share one connection/pool (closing is reference-safe).
 */
export function createDatabases(opts: CreateDatabasesOptions): Databases {
  const common = { baseDir: opts.baseDir, poolFactory: opts.poolFactory, onWarn: opts.onWarn } as const;
  const clean = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
  const main = openDatabase<MainDB>(opts.databaseUrl, clean({ ...common, poolMax: opts.poolMax, applicationName: 'neurouter' }));
  const auditUrl = opts.auditDatabaseUrl ?? opts.databaseUrl;
  const separateAudit = auditUrl !== opts.databaseUrl;
  const audit: DbHandle<AuditDB> = separateAudit
    ? openDatabase<AuditDB>(auditUrl, clean({ ...common, poolMax: opts.auditPoolMax, applicationName: 'neurouter-audit' }))
    : { ...(main as unknown as DbHandle<AuditDB>), close: async () => {} };
  if (separateAudit && audit.dialect !== main.dialect) {
    opts.onWarn?.(`DATABASE_URL is ${main.dialect} but AUDIT_DATABASE_URL is ${audit.dialect}`);
  }
  return {
    main,
    audit,
    separateAudit,
    async close() {
      await audit.close();
      await main.close();
    },
  };
}

/** Runs the main migration set on `main` and the audit set on `audit` (both, even when they share a DB). */
export async function migrateAll(dbs: Databases, ctx: Omit<MigrationContext, 'dialect'>): Promise<{ main: string[]; audit: string[] }> {
  const main = await migrateToLatest(dbs.main.db as Kysely<unknown>, 'main', { ...ctx, dialect: dbs.main.dialect });
  const audit = await migrateToLatest(dbs.audit.db as Kysely<unknown>, 'audit', { ...ctx, dialect: dbs.audit.dialect });
  return { main, audit };
}

/** Cheap liveness probe of a DB handle. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function pingDatabase(handle: DbHandle<any>): Promise<{ ok: true; latencyMs: number; version?: string } | { ok: false; error: string }> {
  const start = performance.now();
  try {
    let version: string | undefined;
    if (handle.native.kind === 'sqlite') {
      const v = sqliteVersions(handle.native.database);
      version = `sqlite ${v.sqlite}, sqlite-vec ${v.vec}`;
    } else {
      await sql`select 1`.execute(handle.db);
    }
    return { ok: true, latencyMs: Math.round(performance.now() - start), ...(version ? { version } : {}) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export type { MainDB, AuditDB };
