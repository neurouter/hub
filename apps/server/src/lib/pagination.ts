import { PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX } from '@neurouter/shared';
import { AppError } from './errors.js';

/** Cursor payload: the sort key tuple of the last row, e.g. `[createdAt, id]`. */
export type CursorKey = readonly (string | number | null)[];

export function encodeCursor(key: CursorKey): string {
  return Buffer.from(JSON.stringify({ k: key }), 'utf8').toString('base64url');
}

/** Decodes an opaque cursor; a malformed one is a 422 (never a 500). */
export function decodeCursor(cursor: string | undefined | null): CursorKey | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { k?: unknown }).k)) {
      const k = (parsed as { k: unknown[] }).k;
      if (k.every((v) => v === null || typeof v === 'string' || typeof v === 'number')) return k as CursorKey;
    }
  } catch {
    // fall through
  }
  throw AppError.validation('Invalid cursor', [{ path: ['cursor'], message: 'Invalid cursor', code: 'invalid_cursor' }]);
}

export function clampLimit(limit: number | undefined, def = PAGE_LIMIT_DEFAULT, max = PAGE_LIMIT_MAX): number {
  if (limit === undefined || !Number.isFinite(limit)) return def;
  return Math.min(max, Math.max(1, Math.trunc(limit)));
}

/**
 * Builds a page from `limit + 1` fetched rows: the extra row only signals that there is more.
 */
export function toPage<R, T>(rows: R[], limit: number, map: (r: R) => T, keyOf: (r: R) => CursorKey) {
  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const last = slice[slice.length - 1];
  return {
    items: slice.map(map),
    nextCursor: hasMore && last !== undefined ? encodeCursor(keyOf(last)) : null,
  };
}
