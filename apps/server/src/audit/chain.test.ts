import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { auditMacKey, chainEntry, checkpointMac, CHAIN_FIELDS, computeHash, entryBody, genesisPrev, hashRow, verifyCheckpointMac } from './chain.js';

const row = { seq: 1, id: '0193-a', ts: 1_700_000_000_000, kind: 'tool_call', decision: 'allowed', status: 'ok', params_redacted: '{"b":1,"a":"x"}', user_id: 'u1', hash: 'ignored', prev_hash: 'ignored', params_text: 'not chained' };

describe('audit hash chain', () => {
  it('genesis is sha256("neurouter-audit-genesis:" + installId)', () => {
    expect(genesisPrev('inst-1')).toBe(createHash('sha256').update('neurouter-audit-genesis:inst-1').digest('hex'));
  });

  it('entry body is JCS over every chain field, nulls explicit, JSON columns parsed', () => {
    const e = chainEntry(row);
    expect(Object.keys(e)).toEqual([...CHAIN_FIELDS]);
    expect(e.params_redacted).toEqual({ b: 1, a: 'x' });
    expect(e.agent_id).toBeNull();
    const body = entryBody(row);
    expect(body).toContain('"params_redacted":{"a":"x","b":1}'); // JCS sorts keys
    expect(body).not.toContain('params_text');
    expect(body).not.toContain('ignored');
    // stored as jsonb object (PG) or TEXT (SQLite) → same body
    expect(entryBody({ ...row, params_redacted: { a: 'x', b: 1 } })).toBe(body);
    expect(entryBody({ ...row, seq: '1', ts: String(row.ts) })).toBe(body);
  });

  it('hash = sha256(prevBytes || 0x1E || body) (golden vector)', () => {
    const prev = genesisPrev('inst-1');
    const body = entryBody(row);
    const manual = createHash('sha256').update(Buffer.concat([Buffer.from(prev, 'hex'), Buffer.from([0x1e]), Buffer.from(body, 'utf8')])).digest('hex');
    expect(computeHash(prev, body)).toBe(manual);
    expect(hashRow(prev, row)).toBe(manual);
    expect(hashRow(prev, { ...row, status: 'tool_error' })).not.toBe(manual);
  });

  it('checkpoint MAC = HMAC-SHA256(macKey, "ckpt|seq|hash|kind") and verifies', () => {
    const key = auditMacKey(Buffer.alloc(32, 7));
    const mac = checkpointMac(key, 42, 'ab'.repeat(32), 'periodic');
    expect(mac).toBe(createHmac('sha256', key).update(`ckpt|42|${'ab'.repeat(32)}|periodic`).digest('hex'));
    expect(verifyCheckpointMac(key, { seq: 42, hash: 'ab'.repeat(32), kind: 'periodic', mac })).toBe(true);
    expect(verifyCheckpointMac(key, { seq: 43, hash: 'ab'.repeat(32), kind: 'periodic', mac })).toBe(false);
    expect(verifyCheckpointMac(auditMacKey(Buffer.alloc(32, 8)), { seq: 42, hash: 'ab'.repeat(32), kind: 'periodic', mac })).toBe(false);
  });
});
