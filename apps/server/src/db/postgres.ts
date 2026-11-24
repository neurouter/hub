import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { registerTypes } from 'pgvector/pg';
import { EmptyInListPlugin } from './empty-in-plugin.js';

/** int8 (bigint) → Number: epoch-ms timestamps and seqs stay < 2^53 (backend §4.1). */
export const PG_INT8_OID = 20;
/** json/jsonb → raw text, like SQLite TEXT, so parseJsonColumn sees one shape on both dialects
 * (pg would otherwise hand back parsed values, and a JSON string value would be parsed twice). */
export const PG_JSON_OID = 114;
export const PG_JSONB_OID = 3802;

let parsersInstalled = false;
/** Installs global pg type parsers once (idempotent). */
export function installPgTypeParsers(types: Pick<typeof pg.types, 'setTypeParser'> = pg.types): void {
  if (parsersInstalled && types === pg.types) return;
  types.setTypeParser(PG_INT8_OID, (v: string) => (v === null ? null : Number(v)) as unknown as number);
  types.setTypeParser(PG_JSON_OID, (v: string) => v);
  types.setTypeParser(PG_JSONB_OID, (v: string) => v);
  if (types === pg.types) parsersInstalled = true;
}

export interface PostgresOptions {
  connectionString: string;
  max: number;
  applicationName?: string;
}

/** Minimal surface of pg.Pool used here, so tests can inject a fake. */
export interface PoolLike {
  on(event: 'connect', listener: (client: pg.PoolClient) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  end(): Promise<void>;
}

export type PoolFactory = (config: pg.PoolConfig) => pg.Pool;

export interface PostgresHandle<DB> {
  db: Kysely<DB>;
  pool: pg.Pool;
}

/**
 * Creates a pg Pool + Kysely. pgvector types are registered per connection when the extension
 * exists (it is created by migration 0006; before that the registration is skipped).
 */
export function createPostgres<DB>(
  opts: PostgresOptions,
  deps: { poolFactory?: PoolFactory; onWarn?: (msg: string, err?: unknown) => void } = {},
): PostgresHandle<DB> {
  installPgTypeParsers();
  const factory = deps.poolFactory ?? ((c: pg.PoolConfig) => new pg.Pool(c));
  const pool = factory({
    connectionString: opts.connectionString,
    max: opts.max,
    application_name: opts.applicationName ?? 'neurouter',
  });
  pool.on('connect', (client) => {
    registerTypes(client).catch((err: unknown) => {
      if (!String((err as Error)?.message).includes('vector type not found')) deps.onWarn?.('pgvector type registration failed', err);
    });
  });
  pool.on('error', (err) => deps.onWarn?.('idle postgres client error', err));
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }), plugins: [new EmptyInListPlugin()] });
  return { db, pool };
}
