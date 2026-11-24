import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EnvKeyring } from '../secrets/keyring.js';
import { originAllowed } from './origin.js';
import { ArgValidator } from './arg-validate.js';
import { sessionKeyOf } from './call-pipeline.js';
import { traceIdOf } from './context.js';
import { RequestStateError, unwrapRequestState, wrapRequestState } from './translate.js';

const ring = new EnvKeyring(new Map([['k1', randomBytes(32)]]), 'k1');
const st = { s: 'up', srv: 's1', tool: 't1', uid: 'u1', aid: 'a1', exp: 2000 };

describe('MRTR requestState wrapping', () => {
  it('round-trips and hides the upstream state', () => {
    const w = wrapRequestState(ring, st);
    expect(w).toMatch(/^v1\.k1\./);
    expect(Buffer.from(w.split('.')[2]!, 'base64url').toString('latin1')).not.toContain('"up"');
    expect(unwrapRequestState(ring, w, { uid: 'u1', aid: 'a1', now: 1000, srv: 's1', tool: 't1' })).toEqual(st);
  });
  it.each([
    [{ uid: 'u2', aid: 'a1', now: 1000 }, /another principal/],
    [{ uid: 'u1', aid: 'a2', now: 1000 }, /another principal/],
    [{ uid: 'u1', aid: 'a1', now: 2000 }, /expired/],
    [{ uid: 'u1', aid: 'a1', now: 1000, srv: 's2' }, /another server/],
    [{ uid: 'u1', aid: 'a1', now: 1000, tool: 't2' }, /another tool/],
  ])('rejects replay %o', (expect_, msg) => {
    expect(() => unwrapRequestState(ring, wrapRequestState(ring, st), expect_)).toThrow(msg);
  });
  it('rejects tampering and foreign keys', () => {
    const w = wrapRequestState(ring, st);
    const bad = w.slice(0, -2) + (w.endsWith('A') ? 'BB' : 'AA');
    expect(() => unwrapRequestState(ring, bad, { uid: 'u1', aid: 'a1', now: 0 })).toThrow(RequestStateError);
    const other = new EnvKeyring(new Map([['k1', randomBytes(32)]]), 'k1');
    expect(() => unwrapRequestState(other, w, { uid: 'u1', aid: 'a1', now: 0 })).toThrow(/tampered/);
    expect(() => unwrapRequestState(ring, 'garbage', { uid: 'u1', aid: 'a1', now: 0 })).toThrow(/malformed/);
  });
});

describe('origin', () => {
  it.each([
    [undefined, true],
    ['http://gw.test', true],
    ['https://app.test', true],
    ['https://evil.test', false],
    ['null', false],
  ])('%s → %s', (origin, ok) => expect(originAllowed(origin, 'http://gw.test', ['https://app.test'])).toBe(ok));
});

describe('arg validation', () => {
  const v = new ArgValidator();
  it('validates JSON Schema 2020-12 with formats and caches per hash', () => {
    const schema = { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { email: { type: 'string', format: 'email' }, n: { type: 'integer', minimum: 1 } }, required: ['email'], additionalProperties: false };
    expect(v.check('h1', schema, { email: 'a@b.co', n: 2 })).toEqual({ ok: true });
    const bad = v.check('h1', schema, { email: 'nope', n: 0, x: 1 });
    expect(bad.ok).toBe(false);
    expect((bad as { errors: string[] }).errors.join(' ')).toMatch(/format[\s\S]*>= 1|>= 1[\s\S]*format/);
  });
  it('fails closed on remote $ref and oversized schemas', () => {
    expect(v.check('h2', { $ref: 'https://evil.test/schema.json' }, {})).toMatchObject({ ok: false, errors: [expect.stringMatching(/cannot be compiled/)] });
    let deep: Record<string, unknown> = { type: 'object' };
    for (let i = 0; i < 40; i++) deep = { type: 'object', properties: { a: deep } };
    expect(v.check('h3', deep, {})).toMatchObject({ ok: false, errors: [expect.stringMatching(/limits/)] });
  });
});

describe('session key derivation order', () => {
  const tp = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
  it.each([
    [{ 'dev.neurouter/session-id': 'abc' }, {}, { source: 'client', externalKey: 'abc' }],
    [{ traceparent: tp }, {}, { source: 'trace', externalKey: '0af7651916cd43dd8448eb211c80319c' }],
    [{}, { traceparent: tp }, { source: 'trace', externalKey: '0af7651916cd43dd8448eb211c80319c' }],
    [{}, { legacySessionId: 'L1' }, { source: 'legacy', externalKey: 'L1' }],
    [{}, {}, { source: 'idle_gap', externalKey: '' }],
    [{ 'dev.neurouter/session-id': 'x'.repeat(200) }, {}, { source: 'idle_gap', externalKey: '' }],
  ])('%o %o', (meta, rc, expected) => {
    expect(sessionKeyOf(meta, { traceparent: null, legacySessionId: null, ...rc })).toEqual(expected);
  });
  it('ignores all-zero trace ids', () => expect(traceIdOf('00-00000000000000000000000000000000-b7ad6b7169203331-01')).toBeNull());
});
