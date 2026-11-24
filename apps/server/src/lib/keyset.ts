import { sql, type Expression, type SelectQueryBuilder, type SqlBool } from 'kysely';
import { AppError } from './errors.js';
import { decodeCursor, encodeCursor, type CursorKey } from './pagination.js';

export interface KeysetSpec {
  /** SQL expression of the sort key (non-null: wrap nullable columns in coalesce). */
  sortExpr: Expression<string | number>;
  /** Unique tie-breaker column (e.g. `users.id`). */
  idExpr: Expression<string>;
  order: 'asc' | 'desc';
  kind: 'string' | 'number';
}

/**
 * Keyset pagination over `(sortKey, id)`: deterministic, stable under inserts, cursor-only.
 * Fetches `limit + 1` rows so the caller can tell whether there is a next page.
 */
export function applyKeyset<DB, TB extends keyof DB, O>(
  qb: SelectQueryBuilder<DB, TB, O>,
  spec: KeysetSpec,
  cursor: string | undefined,
  limit: number,
): SelectQueryBuilder<DB, TB, O> {
  const key = decodeCursor(cursor);
  const dir = spec.order === 'asc' ? sql.raw('>') : sql.raw('<');
  let q = qb;
  if (key) {
    const [v, id] = key;
    if (typeof id !== 'string' || (spec.kind === 'number' ? typeof v !== 'number' : typeof v !== 'string'))
      throw AppError.validation('Invalid cursor', [{ path: ['cursor'], message: 'Cursor does not match the sort order', code: 'invalid_cursor' }]);
    q = q.where(sql<SqlBool>`(${spec.sortExpr} ${dir} ${v} or (${spec.sortExpr} = ${v} and ${spec.idExpr} ${dir} ${id}))`);
  }
  const ord = spec.order === 'asc' ? sql.raw('asc') : sql.raw('desc');
  return q.orderBy(sql`${spec.sortExpr} ${ord}`).orderBy(sql`${spec.idExpr} ${ord}`).limit(limit + 1);
}

/** Builds `Page<T>` from `limit + 1` rows. */
export function keysetPage<R, T>(rows: R[], limit: number, map: (r: R) => T, keyOf: (r: R) => CursorKey): { items: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const last = slice[slice.length - 1];
  return { items: slice.map(map), nextCursor: hasMore && last !== undefined ? encodeCursor(keyOf(last)) : null };
}

/** Case-insensitive LIKE pattern with escaped wildcards. */
export function likePattern(q: string): string {
  return `%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** `lower(expr) LIKE '%q%' ESCAPE '\'` (portable SQLite/PG substring search). */
export function containsCi(expr: Expression<unknown>, q: string): Expression<SqlBool> {
  return sql<SqlBool>`lower(${expr}) like ${likePattern(q)} escape '\\'`;
}
