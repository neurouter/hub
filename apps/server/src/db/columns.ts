import { sql, type RawBuilder } from 'kysely';
import type { Dialect } from './url.js';

/**
 * Portable column types (backend plan §4.1). Ids are app-generated UUIDv7 strings, timestamps
 * are epoch ms, booleans are 0/1, JSON is TEXT (SQLite) / jsonb (PG), binary is BLOB / bytea.
 */
export function columnTypes(dialect: Dialect) {
  const pg = dialect === 'postgres';
  return {
    id: pg ? 'uuid' : 'text',
    text: 'text',
    ts: pg ? 'bigint' : 'integer',
    int: 'integer',
    bigint: pg ? 'bigint' : 'integer',
    bool: pg ? 'smallint' : 'integer',
    json: pg ? 'jsonb' : 'text',
    blob: pg ? 'bytea' : 'blob',
    float: pg ? 'double precision' : 'real',
  } as const;
}

export type ColumnTypes = ReturnType<typeof columnTypes>;

/** `CHECK (<col> IN ('a','b'))` (no PG enum types, so migrations stay simple). */
export function inList(column: string, values: readonly string[]): RawBuilder<unknown> {
  return sql`${sql.ref(column)} in (${sql.join(values.map((v) => sql.lit(v)))})`;
}

/** `CHECK (<col> IN (0,1))` for portable booleans. */
export function isBool(column: string): RawBuilder<unknown> {
  return sql`${sql.ref(column)} in (0, 1)`;
}

/** JSON literal default (`'{}'`, `'[]'`). Works for TEXT and jsonb. */
export function jsonDefault(literal: '{}' | '[]'): RawBuilder<unknown> {
  return sql.raw(`'${literal}'`);
}
