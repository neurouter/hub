import type { Kysely } from 'kysely';
import type { MainDB } from '../db/schema.js';
import { newId } from '../lib/ids.js';
import { claimContains } from './roles.js';

export interface GroupSyncResult {
  added: string[];
  removed: string[];
  created: string[];
}

/**
 * OIDC group sync (backend §7.1): every `group_claim_mappings` row is evaluated against the
 * user's claims; the matched groups are the target set of `group_memberships(source='oidc')`.
 * Local memberships are untouched. With auto-create, unseen values of the groups claim first
 * create `groups(source='oidc')` plus a mapping.
 */
export async function syncOidcGroups(
  db: Kysely<MainDB>,
  input: { userId: string; claims: Record<string, unknown>; groupsClaim: string; autoCreate: boolean; now: number },
): Promise<GroupSyncResult> {
  const { userId, claims, groupsClaim, now } = input;
  return db.transaction().execute(async (trx) => {
    const created: string[] = [];
    if (input.autoCreate) {
      const raw = claims[groupsClaim];
      const values = (Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []).filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 100);
      for (const value of values) {
        const mapped = await trx.selectFrom('group_claim_mappings').select('id').where('claim', '=', groupsClaim).where('value', '=', value).executeTakeFirst();
        if (mapped) continue;
        let group = await trx.selectFrom('groups').select('id').where('name', '=', value).executeTakeFirst();
        if (!group) {
          group = { id: newId() };
          await trx.insertInto('groups').values({ id: group.id, name: value, description: `Synced from the ${groupsClaim} claim`, source: 'oidc', created_at: now, updated_at: now }).execute();
          created.push(group.id);
        }
        await trx.insertInto('group_claim_mappings').values({ id: newId(), group_id: group.id, claim: groupsClaim, value, last_seen_at: null, created_by: null, created_at: now }).execute();
      }
    }

    const mappings = await trx.selectFrom('group_claim_mappings').select(['id', 'group_id', 'claim', 'value']).execute();
    const target = new Set<string>();
    const seen: string[] = [];
    for (const m of mappings) {
      if (claimContains(claims, m.claim, m.value)) {
        target.add(m.group_id);
        seen.push(m.id);
      }
    }
    if (seen.length) await trx.updateTable('group_claim_mappings').set({ last_seen_at: now }).where('id', 'in', seen).execute();

    const current = await trx.selectFrom('group_memberships').select(['group_id', 'source']).where('user_id', '=', userId).execute();
    const bySource = new Map(current.map((c) => [c.group_id, c.source]));
    const added: string[] = [];
    const removed: string[] = [];
    for (const gid of target) {
      if (!bySource.has(gid)) {
        await trx.insertInto('group_memberships').values({ group_id: gid, user_id: userId, source: 'oidc', created_at: now }).execute();
        added.push(gid);
      }
    }
    for (const [gid, src] of bySource) {
      if (src === 'oidc' && !target.has(gid)) {
        await trx.deleteFrom('group_memberships').where('group_id', '=', gid).where('user_id', '=', userId).execute();
        removed.push(gid);
      }
    }
    return { added, removed, created };
  });
}
