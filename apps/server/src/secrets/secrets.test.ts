import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../test/fakes/test-db.js';
import { DecryptError, open, pack, seal, unpack } from './envelope.js';
import { EnvKeyring } from './keyring.js';
import { EnvelopeService } from './envelope.service.js';
import { BuiltinSecretProvider } from './builtin.provider.js';
import { rotateKeys } from './rotation.js';

const clock = { now: () => 1_700_000_000_000 };

describe('envelope (AES-256-GCM)', () => {
  const key = randomBytes(32);
  it('round-trips and packs', () => {
    const s = seal(key, Buffer.from('hello'), 'aad');
    expect(open(key, s, 'aad').toString()).toBe('hello');
    expect(open(key, unpack(pack(s)), 'aad').toString()).toBe('hello');
    expect(s.ciphertext.includes(Buffer.from('hello'))).toBe(false);
  });
  it('fails on AAD mismatch, wrong key and tampering', () => {
    const s = seal(key, Buffer.from('hello'), 'aad');
    expect(() => open(key, s, 'other')).toThrow(DecryptError);
    expect(() => open(randomBytes(32), s, 'aad')).toThrow(DecryptError);
    const t = Buffer.from(s.ciphertext);
    t[0] = t[0]! ^ 1;
    expect(() => open(key, { nonce: s.nonce, ciphertext: t }, 'aad')).toThrow(DecryptError);
    expect(() => open(key, { nonce: Buffer.alloc(3), ciphertext: t }, 'aad')).toThrow(DecryptError);
  });
  it('rejects bad key sizes', () => {
    expect(() => seal(Buffer.alloc(16), Buffer.from('x'), 'a')).toThrow();
  });
});

describe('keyring + envelope service + builtin provider', () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  const k1 = randomBytes(32);
  const k2 = randomBytes(32);
  beforeEach(async () => { t = await createTestDb(); });
  afterEach(async () => { await t.close(); });

  it('stores ciphertext only and decrypts with AAD bound to the row', async () => {
    const env = new EnvelopeService(t.db, new EnvKeyring(new Map([['k1', k1]]), 'k1'), clock);
    const p = new BuiltinSecretProvider(t.db, env, clock);
    const ref = await p.put({ purpose: 'server_credential', value: Buffer.from('s3cret-token') });
    const row = await t.db.selectFrom('secrets').selectAll().where('id', '=', ref.id).executeTakeFirstOrThrow();
    expect(row.ciphertext!.includes(Buffer.from('s3cret-token'))).toBe(false);
    expect((await p.get(ref)).toString()).toBe('s3cret-token');
    // swapping ciphertext between rows fails (AAD includes the id)
    const other = await p.put({ purpose: 'server_credential', value: Buffer.from('other') });
    await t.db.updateTable('secrets').set({ nonce: row.nonce, ciphertext: row.ciphertext }).where('id', '=', other.id).execute();
    await expect(p.get(other)).rejects.toThrow(DecryptError);
    // replace bumps the version
    await p.put({ id: ref.id, purpose: 'server_credential', value: Buffer.from('v2') });
    expect((await p.get(ref)).toString()).toBe('v2');
    expect(await p.updatedAt(ref)).toBe(clock.now());
    await p.delete(ref);
    await expect(p.get(ref)).rejects.toThrow();
  });

  it('KEK rotation rewraps DEKs; DEK rotation re-encrypts and deletes unused DEKs', async () => {
    const env1 = new EnvelopeService(t.db, new EnvKeyring(new Map([['k1', k1]]), 'k1'), clock);
    const p1 = new BuiltinSecretProvider(t.db, env1, clock);
    const ref = await p1.put({ purpose: 'x', value: Buffer.from('v') });

    const ring2 = new EnvKeyring(new Map([['k1', k1], ['k2', k2]]), 'k2');
    const env2 = new EnvelopeService(t.db, ring2, clock);
    const p2 = new BuiltinSecretProvider(t.db, env2, clock);
    const rew = await rotateKeys({ db: t.db, envelope: env2, secrets: p2 }, 'rewrap');
    expect(rew).toMatchObject({ rewrapped: 1, kekIdsInUse: ['k2'] });
    // k1 can now be removed
    const env3 = new EnvelopeService(t.db, new EnvKeyring(new Map([['k2', k2]]), 'k2'), clock);
    const p3 = new BuiltinSecretProvider(t.db, env3, clock);
    expect((await p3.get(ref)).toString()).toBe('v');

    const before = (await t.db.selectFrom('secrets').select('dek_id').executeTakeFirstOrThrow()).dek_id;
    const rot = await rotateKeys({ db: t.db, envelope: env3, secrets: p3 }, 'dek');
    expect(rot.reencrypted).toBe(1);
    expect(rot.deletedDeks).toBe(1);
    const after = (await t.db.selectFrom('secrets').select('dek_id').executeTakeFirstOrThrow()).dek_id;
    expect(after).not.toBe(before);
    expect((await p3.get(ref)).toString()).toBe('v');
  });

  it('keyring refuses unknown KEKs', () => {
    expect(() => new EnvKeyring(new Map([['k1', k1]]), 'k9')).toThrow();
    const ring = new EnvKeyring(new Map([['k1', k1]]), 'k1');
    const w = ring.wrap('d', randomBytes(32));
    expect(() => ring.unwrap('d', 'k9', w.wrapped)).toThrow(/not configured/);
    expect(() => ring.unwrap('other', 'k1', w.wrapped)).toThrow(DecryptError);
  });
});
