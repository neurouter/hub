import { randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { MainDB } from '../db/schema.js';
import type { Clock } from '../lib/clock.js';
import { newId } from '../lib/ids.js';
import { KEY_BYTES, open, seal, type Sealed } from './envelope.js';
import type { Keyring } from './keyring.js';

export interface SealedRecord extends Sealed {
  dekId: string;
}

/**
 * DEK management + sealing (backend §8): one active data-encryption key, wrapped under the
 * active KEK and stored in `encryption_keys`. Unwrapped DEKs are cached in memory.
 */
export class EnvelopeService {
  private readonly cache = new Map<string, Buffer>();
  private active: { id: string; key: Buffer } | null = null;

  constructor(
    private readonly db: Kysely<MainDB>,
    readonly keyring: Keyring,
    private readonly clock: Clock,
  ) {}

  private remember(id: string, key: Buffer): void {
    if (this.cache.size >= 32) {
      const first = this.cache.keys().next().value;
      if (first !== undefined && first !== this.active?.id) this.cache.delete(first);
    }
    this.cache.set(id, key);
  }

  async activeDek(): Promise<{ id: string; key: Buffer }> {
    if (this.active) return this.active;
    const row = await this.db.selectFrom('encryption_keys').selectAll().where('status', '=', 'active').orderBy('created_at', 'desc').orderBy('id', 'desc').executeTakeFirst();
    if (row) {
      const key = this.keyring.unwrap(row.id, row.kek_id, row.wrapped_key);
      this.active = { id: row.id, key };
      this.remember(row.id, key);
      return this.active;
    }
    return this.createDek();
  }

  /** Creates a new active DEK; older active DEKs become `retired` (rotation re-encrypts their data). */
  async createDek(): Promise<{ id: string; key: Buffer }> {
    const id = newId();
    const key = randomBytes(KEY_BYTES);
    const { kekId, wrapped } = this.keyring.wrap(id, key);
    const now = this.clock.now();
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('encryption_keys').set({ status: 'retired' }).where('status', '=', 'active').execute();
      await trx.insertInto('encryption_keys').values({ id, kek_id: kekId, wrapped_key: wrapped, status: 'active', created_at: now }).execute();
    });
    this.active = { id, key };
    this.remember(id, key);
    return this.active;
  }

  async dekKey(dekId: string): Promise<Buffer> {
    const hit = this.cache.get(dekId);
    if (hit) return hit;
    const row = await this.db.selectFrom('encryption_keys').selectAll().where('id', '=', dekId).executeTakeFirst();
    if (!row) throw new Error(`Unknown DEK ${dekId}`);
    const key = this.keyring.unwrap(row.id, row.kek_id, row.wrapped_key);
    this.remember(dekId, key);
    return key;
  }

  async seal(plaintext: Uint8Array, aad: string): Promise<SealedRecord> {
    const dek = await this.activeDek();
    return { dekId: dek.id, ...seal(dek.key, plaintext, aad) };
  }

  async open(rec: SealedRecord, aad: string): Promise<Buffer> {
    return open(await this.dekKey(rec.dekId), rec, aad);
  }

  /** Rewraps every DEK not under the active KEK (KEK rotation). Returns the number rewrapped. */
  async rewrapAll(): Promise<number> {
    const rows = await this.db.selectFrom('encryption_keys').selectAll().where('kek_id', '!=', this.keyring.activeKekId).execute();
    for (const row of rows) {
      const key = this.keyring.unwrap(row.id, row.kek_id, row.wrapped_key);
      const { kekId, wrapped } = this.keyring.wrap(row.id, key);
      await this.db.updateTable('encryption_keys').set({ kek_id: kekId, wrapped_key: wrapped }).where('id', '=', row.id).execute();
    }
    return rows.length;
  }

  /** Forget the cached active DEK (another replica rotated). */
  invalidate(): void {
    this.active = null;
  }
}
