import type { Kysely } from 'kysely';
import type { MainDB } from '../db/schema.js';
import type { Clock } from '../lib/clock.js';
import { newId } from '../lib/ids.js';
import type { EnvelopeService } from './envelope.service.js';
import type { SecretProvider, SecretRef } from './provider.js';

/** AAD binds the ciphertext to its row, so ciphertext can't be swapped between rows (backend §8). */
export const secretAad = (purpose: string, id: string, version: number) => `neurouter:secret:${purpose}:${id}:${version}`;

/** DB-backed envelope store (`secrets` table). `put` with an existing id replaces the value (version + 1). */
export class BuiltinSecretProvider implements SecretProvider {
  readonly kind = 'builtin' as const;

  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly envelope: EnvelopeService,
    private readonly clock: Clock,
  ) {}

  async put(input: { purpose: string; value: Uint8Array; id?: string }): Promise<SecretRef> {
    const now = this.clock.now();
    const existing = input.id ? await this.db.selectFrom('secrets').select(['id', 'version', 'purpose']).where('id', '=', input.id).executeTakeFirst() : undefined;
    const id = existing?.id ?? input.id ?? newId();
    const version = existing ? existing.version + 1 : 1;
    const sealed = await this.envelope.seal(input.value, secretAad(input.purpose, id, version));
    if (existing) {
      await this.db
        .updateTable('secrets')
        .set({ purpose: input.purpose, dek_id: sealed.dekId, nonce: sealed.nonce, ciphertext: sealed.ciphertext, version, updated_at: now })
        .where('id', '=', id)
        .execute();
    } else {
      await this.db
        .insertInto('secrets')
        .values({ id, purpose: input.purpose, provider: 'builtin', external_ref: null, dek_id: sealed.dekId, nonce: sealed.nonce, ciphertext: sealed.ciphertext, version, created_at: now, updated_at: now })
        .execute();
    }
    return { id };
  }

  async get(ref: SecretRef): Promise<Buffer> {
    const row = await this.db.selectFrom('secrets').selectAll().where('id', '=', ref.id).executeTakeFirst();
    if (!row || !row.dek_id || !row.nonce || !row.ciphertext) throw new Error(`Secret ${ref.id} not found`);
    return this.envelope.open({ dekId: row.dek_id, nonce: row.nonce, ciphertext: row.ciphertext }, secretAad(row.purpose, row.id, row.version));
  }

  async delete(ref: SecretRef): Promise<void> {
    await this.db.deleteFrom('secrets').where('id', '=', ref.id).execute();
  }

  async updatedAt(ref: SecretRef): Promise<number | null> {
    const row = await this.db.selectFrom('secrets').select('updated_at').where('id', '=', ref.id).executeTakeFirst();
    return row?.updated_at ?? null;
  }

  /** Re-encrypts every secret not under `activeDekId` (DEK rotation). Returns the number re-encrypted. */
  async reencryptAll(activeDekId: string, batch = 500): Promise<number> {
    let total = 0;
    for (;;) {
      const rows = await this.db.selectFrom('secrets').select(['id', 'purpose']).where('dek_id', '!=', activeDekId).limit(batch).execute();
      if (rows.length === 0) return total;
      for (const r of rows) {
        const value = await this.get(r);
        await this.put({ id: r.id, purpose: r.purpose, value });
        value.fill(0);
      }
      total += rows.length;
    }
  }
}
