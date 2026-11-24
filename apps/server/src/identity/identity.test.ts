import { describe, expect, it } from 'vitest';
import { generateApiKey, hashSecret, parseApiKey, verifySecret } from './api-key-format.js';
import { claimContains, rolesFromMappings } from './roles.js';
import { createTestDb } from '../test/fakes/test-db.js';
import { SettingsService } from '../settings/settings.service.js';
import { MemoryCoordination } from '../coordination/memory.js';

describe('api key format', () => {
  it('generates parseable keys with a display prefix', () => {
    const k = generateApiKey();
    expect(k.token).toBe(`nr_live_${k.keyId}_${k.secret}`);
    expect(k.displayPrefix).toBe(`nr_live_${k.keyId}`);
    expect(parseApiKey(k.token)).toEqual({ keyId: k.keyId, secret: k.secret });
    expect(verifySecret('p'.repeat(32), k.secret, hashSecret('p'.repeat(32), k.secret))).toBe(true);
    expect(verifySecret('p'.repeat(32), k.secret + 'x', hashSecret('p'.repeat(32), k.secret))).toBe(false);
  });
  it.each(['', 'nr_live_', 'nr_at_abc', 'nr_live_SHORT_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', `nr_live_0123456789_${'a'.repeat(10)}`, `nr_live_01234567IL_${'a'.repeat(43)}`, `nr_live_0123456789_${'a'.repeat(42)}!`])('rejects %s', (t) => {
    expect(parseApiKey(t)).toBeNull();
  });
});

describe('claim mappings', () => {
  it('matches string and array claims exactly', () => {
    expect(claimContains({ groups: ['a', 'b'] }, 'groups', 'b')).toBe(true);
    expect(claimContains({ groups: 'a' }, 'groups', 'a')).toBe(true);
    expect(claimContains({ groups: ['ab'] }, 'groups', 'a')).toBe(false);
    expect(claimContains({ groups: 1 }, 'groups', '1')).toBe(false);
    expect(rolesFromMappings({ groups: ['sec', 'ops'] }, [{ claim: 'groups', value: 'ops', role: 'admin' }, { claim: 'groups', value: 'sec', role: 'auditor' }, { claim: 'dept', value: 'x', role: 'admin' }])).toEqual(['admin', 'auditor']);
  });
});

describe('settings service', () => {
  it('returns defaults, persists, seeds role mappings once and invalidates across instances', async () => {
    const t = await createTestDb();
    const coord = new MemoryCoordination();
    const a = new SettingsService(t.db, { now: () => 1 }, coord);
    const b = new SettingsService(t.db, { now: () => 1 }, coord);
    expect(await a.get('catalogVisibility')).toBe('all');
    expect(await a.seedRoleMappings('groups', ['admins'], ['sec'])).toBe(true);
    expect(await a.seedRoleMappings('groups', ['other'], [])).toBe(false);
    expect(await b.get('oidcRoleMappings')).toEqual([{ claim: 'groups', value: 'admins', role: 'admin' }, { claim: 'groups', value: 'sec', role: 'auditor' }]);
    await a.set('catalogVisibility', 'granted');
    await new Promise((r) => setTimeout(r, 5));
    expect(await b.get('catalogVisibility')).toBe('granted');
    await coord.close();
    await t.close();
  });
});
