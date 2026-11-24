import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import * as sqliteVec from 'sqlite-vec';
import { EmptyInListPlugin } from './empty-in-plugin.js';

export interface SqliteOptions {
  filename: string;
  /** default 5000 ms */
  busyTimeoutMs?: number;
  readonly?: boolean;
}

/**
 * Opens better-sqlite3 with the pragmas the app relies on and loads sqlite-vec (backend §4.3:
 * the extension is loaded on every connection open, before Kysely is created).
 */
export function openSqlite(opts: SqliteOptions): Database.Database {
  if (opts.filename !== ':memory:') mkdirSync(dirname(opts.filename), { recursive: true });
  const db = new Database(opts.filename, { readonly: opts.readonly ?? false });
  if (opts.filename !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma(`busy_timeout = ${Math.trunc(opts.busyTimeoutMs ?? 5000)}`);
  db.pragma('synchronous = NORMAL');
  sqliteVec.load(db);
  return db;
}

export function createSqliteKysely<DB>(database: Database.Database): Kysely<DB> {
  return new Kysely<DB>({ dialect: new SqliteDialect({ database }), plugins: [new EmptyInListPlugin()] });
}

/** Versions reported by /readyz and logs. */
export function sqliteVersions(database: Database.Database): { sqlite: string; vec: string } {
  const row = database.prepare('select sqlite_version() as sqlite, vec_version() as vec').get() as { sqlite: string; vec: string };
  return row;
}
