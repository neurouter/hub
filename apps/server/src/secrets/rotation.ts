import type { Kysely } from 'kysely';
import type { MainDB } from '../db/schema.js';
import type { BuiltinSecretProvider } from './builtin.provider.js';
import type { EnvelopeService } from './envelope.service.js';

export interface RotationResult {
  type: 'dek' | 'rewrap';
  rewrapped: number;
  reencrypted: number;
  /** KEK ids that still wrap at least one DEK (a KEK can be removed when absent here). */
  kekIdsInUse: string[];
  deletedDeks: number;
}

/**
 * Key rotation (backend §8).
 * - `rewrap`: rewrap every DEK under the active KEK (after adding a new KEK and restarting).
 * - `dek`: create a new active DEK, re-encrypt secrets under it, delete retired DEKs nothing references.
 * Upstream OAuth tokens (step 10) re-encrypt through `extraReencrypt`.
 */
export async function rotateKeys(
  deps: { db: Kysely<MainDB>; envelope: EnvelopeService; secrets: BuiltinSecretProvider; extraReencrypt?: (activeDekId: string) => Promise<number> },
  type: 'dek' | 'rewrap',
): Promise<RotationResult> {
  let rewrapped = 0;
  let reencrypted = 0;
  let deletedDeks = 0;
  if (type === 'rewrap') {
    rewrapped = await deps.envelope.rewrapAll();
  } else {
    const dek = await deps.envelope.createDek();
    reencrypted = await deps.secrets.reencryptAll(dek.id);
    if (deps.extraReencrypt) reencrypted += await deps.extraReencrypt(dek.id);
    const retired = await deps.db.selectFrom('encryption_keys').select('id').where('status', '=', 'retired').execute();
    for (const { id } of retired) {
      const s = await deps.db.selectFrom('secrets').select('id').where('dek_id', '=', id).limit(1).executeTakeFirst();
      const t = await deps.db.selectFrom('user_upstream_tokens').select('id').where('dek_id', '=', id).limit(1).executeTakeFirst();
      if (!s && !t) {
        await deps.db.deleteFrom('encryption_keys').where('id', '=', id).execute();
        deletedDeks++;
      }
    }
  }
  const keks = await deps.db.selectFrom('encryption_keys').select('kek_id').distinct().execute();
  return { type, rewrapped, reencrypted, kekIdsInUse: keks.map((k) => k.kek_id).sort(), deletedDeks };
}
