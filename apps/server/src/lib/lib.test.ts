import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { hkdf, hmacSha256Hex, randomToken, sha256Hex, timingSafeEqualBuf, timingSafeEqualStr } from './crypto.js';
import { canonicalJson, hashCanonical } from './jcs.js';
import { fromBool, parseJsonColumn, toBool, toJsonColumn } from './json.js';
import { clampLimit, decodeCursor, encodeCursor, toPage } from './pagination.js';
import { AppError } from './errors.js';
import { createLogger } from './logger.js';
import { fromIso, toIso, toIsoOrNull } from './clock.js';
import { newId } from './ids.js';

describe('crypto', () => {
  it('randomToken is base62 with the expected length and unique', () => {
    const t = randomToken(32);
    expect(t).toMatch(/^[0-9A-Za-z]{43}$/);
    expect(randomToken(32)).not.toBe(t);
  });
  it('hashes and compares', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hmacSha256Hex('key', 'The quick brown fox jumps over the lazy dog')).toBe('f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
    expect(timingSafeEqualStr('a', 'a')).toBe(true);
    expect(timingSafeEqualStr('a', 'ab')).toBe(false);
    expect(timingSafeEqualBuf(Buffer.from('x'), Buffer.from('y'))).toBe(false);
    expect(hkdf(Buffer.alloc(32, 1), 'mrtr').length).toBe(32);
  });
});

describe('jcs', () => {
  it('is independent of key order (RFC 8785)', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'] })).toBe('{"a":[true,null,"x"],"b":1}');
    expect(hashCanonical({ b: 1, a: 2 })).toBe(hashCanonical({ a: 2, b: 1 }));
    expect(() => canonicalJson(undefined)).toThrow();
  });
});

describe('json/bool columns', () => {
  it('round-trips for both dialects', () => {
    expect(parseJsonColumn(toJsonColumn({ a: 1 }))).toEqual({ a: 1 });
    expect(parseJsonColumn({ a: 1 })).toEqual({ a: 1 });
    expect(parseJsonColumn(null)).toBeNull();
    expect(parseJsonColumn(Buffer.from('[1]'))).toEqual([1]);
    expect(toBool(1)).toBe(true);
    expect(toBool(0)).toBe(false);
    expect(toBool(null)).toBe(false);
    expect(fromBool(true)).toBe(1);
  });
});

describe('pagination', () => {
  it('round-trips cursors and rejects garbage with a 422', () => {
    const c = encodeCursor([1732406400000, 'id-1']);
    expect(decodeCursor(c)).toEqual([1732406400000, 'id-1']);
    expect(decodeCursor(undefined)).toBeNull();
    expect(() => decodeCursor('not-base64-json')).toThrow(AppError);
    expect(() => decodeCursor(Buffer.from('{"k":[{}]}').toString('base64url'))).toThrow(/Invalid cursor/);
  });
  it('clamps limits and builds pages from limit+1 rows', () => {
    expect(clampLimit(undefined)).toBe(50);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(1000)).toBe(200);
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const page = toPage(rows, 2, (r) => r.id, (r) => [r.id]);
    expect(page.items).toEqual(['a', 'b']);
    expect(decodeCursor(page.nextCursor)).toEqual(['b']);
    expect(toPage(rows, 5, (r) => r.id, (r) => [r.id]).nextCursor).toBeNull();
  });
});

describe('AppError', () => {
  it('derives status and title from the shared catalog', () => {
    const e = AppError.rateLimited(7);
    expect(e.status).toBe(429);
    expect(e.headers).toEqual({ 'retry-after': '7' });
    expect(AppError.notFound('Server').message).toBe('Server not found');
    expect(AppError.validation('bad', [{ path: ['a'], message: 'x', code: 'c' }]).fieldErrors).toHaveLength(1);
    expect(new AppError('gone').message).toBe('Gone');
  });
});

describe('logger', () => {
  it('redacts credentials', () => {
    const lines: string[] = [];
    const dest = new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); } });
    const log = createLogger({ level: 'info', pretty: false }, dest as never);
    log.info({ req: { headers: { authorization: 'Bearer nr_live_abc', cookie: 'nr_session=x' } }, body: { password: 'p', token: 't' } }, 'hi');
    const out = lines.join('');
    expect(out).not.toContain('nr_live_abc');
    expect(out).not.toContain('nr_session=x');
    expect(out).not.toMatch(/"password":"p"/);
    expect(out).toContain('[REDACTED]');
  });
});

describe('clock and ids', () => {
  it('formats timestamps', () => {
    expect(toIso(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(toIsoOrNull(null)).toBeNull();
    expect(fromIso('1970-01-01T00:00:01Z')).toBe(1000);
    expect(() => fromIso('nope')).toThrow();
  });
  it('generates time-ordered UUIDv7 ids', () => {
    const a = newId();
    const b = newId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});
