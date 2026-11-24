/** JSON columns are TEXT in SQLite and jsonb in Postgres (backend §4.1). */
export type JsonColumn = string;

export function toJsonColumn(value: unknown): JsonColumn {
  return JSON.stringify(value);
}

/** Reads a JSON column: strings are parsed (SQLite), objects pass through (pg jsonb). */
export function parseJsonColumn<T = unknown>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return JSON.parse(value) as T;
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString('utf8')) as T;
  return value as T;
}

/** Booleans are 0/1 integers on both dialects. */
export function toBool(v: number | bigint | boolean | null | undefined): boolean {
  return v === true || v === 1 || v === 1n;
}

export function fromBool(v: boolean): 0 | 1 {
  return v ? 1 : 0;
}
