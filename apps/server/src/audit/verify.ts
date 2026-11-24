import type { Kysely } from 'kysely';
import type { AuditDB } from '../db/schema.js';
import { genesisPrev, hashRow, verifyCheckpointMac, type CheckpointKind } from './chain.js';
import type { AuditVerifyOutcome, BrokenReason } from './types.js';

export interface VerifyDeps {
  db: Kysely<AuditDB>;
  installId: string;
  /** MAC key for a checkpoint key id (null when that key is no longer configured). */
  macKeyFor: (keyId: string) => Buffer | null;
  pageSize?: number;
  onProgress?: (checked: number) => void | Promise<void>;
}

/**
 * Chain verification (backend §9.4): rows are streamed by `seq` in pages of 5,000 and checked
 * for contiguity, `prev_hash` linkage and recomputed hashes; every checkpoint in range must have
 * a valid MAC and match the row hash at its seq; the earliest retained row must link to genesis
 * (seq 1) or to a `retention_cut` checkpoint.
 */
export async function verifyChain(d: VerifyDeps, range: { fromSeq?: number; toSeq?: number } = {}): Promise<AuditVerifyOutcome> {
  const pageSize = d.pageSize ?? 5000;
  const minRow = await d.db.selectFrom('audit_log').select('seq').orderBy('seq', 'asc').limit(1).executeTakeFirst();
  const maxRow = await d.db.selectFrom('audit_log').select('seq').orderBy('seq', 'desc').limit(1).executeTakeFirst();
  const empty: AuditVerifyOutcome = { ok: true, checked: 0, firstSeq: null, lastSeq: null, checkpointsVerified: 0, brokenAt: null };
  if (!minRow || !maxRow) return empty;
  const earliest = Number(minRow.seq);
  const from = Math.max(range.fromSeq ?? earliest, earliest);
  const to = Math.min(range.toSeq ?? Number(maxRow.seq), Number(maxRow.seq));
  if (to < from) return empty;

  const fail = (seq: number, eventId: string | null, reason: BrokenReason, expected: string | null, actual: string | null, checked: number, cps: number): AuditVerifyOutcome => ({
    ok: false, checked, firstSeq: from, lastSeq: to, checkpointsVerified: cps, brokenAt: { seq, eventId, reason, expected, actual },
  });

  // expected prev_hash of the first row in range
  let expectedPrev: string | null;
  if (from === earliest) {
    if (from === 1) expectedPrev = genesisPrev(d.installId);
    else {
      const cut = await d.db.selectFrom('audit_checkpoints').select(['hash']).where('seq', '=', from - 1).where('kind', '=', 'retention_cut').orderBy('created_at', 'desc').executeTakeFirst();
      expectedPrev = cut?.hash ?? null;
      if (expectedPrev === null) {
        const first = await d.db.selectFrom('audit_log').select(['id', 'prev_hash']).where('seq', '=', from).executeTakeFirst();
        return fail(from, first?.id ?? null, 'broken_link', null, first?.prev_hash ?? null, 0, 0);
      }
    }
  } else {
    const before = await d.db.selectFrom('audit_log').select('hash').where('seq', '=', from - 1).executeTakeFirst();
    expectedPrev = before?.hash ?? null; // null → the row before is missing: reported as a gap below
  }

  const checkpoints = (await d.db.selectFrom('audit_checkpoints').selectAll().where('seq', '>=', from).where('seq', '<=', to).orderBy('seq', 'asc').execute()).map((c) => ({
    ...c,
    seq: Number(c.seq),
  }));
  let cpIdx = 0;
  let cpsVerified = 0;

  let checked = 0;
  let nextSeq = from;
  let cursor = from - 1;
  for (;;) {
    const rows = await d.db.selectFrom('audit_log').selectAll().where('seq', '>', cursor).where('seq', '<=', to).orderBy('seq', 'asc').limit(pageSize).execute();
    if (!rows.length) break;
    for (const r of rows) {
      const seq = Number(r.seq);
      if (seq !== nextSeq) return fail(nextSeq, null, 'gap', String(nextSeq), String(seq), checked, cpsVerified);
      if (expectedPrev === null) return fail(seq, r.id, 'gap', String(seq - 1), null, checked, cpsVerified);
      if (r.prev_hash !== expectedPrev) return fail(seq, r.id, 'broken_link', expectedPrev, r.prev_hash, checked, cpsVerified);
      const recomputed = hashRow(r.prev_hash, r as unknown as Record<string, unknown>);
      if (recomputed !== r.hash) return fail(seq, r.id, 'hash_mismatch', recomputed, r.hash, checked, cpsVerified);
      while (cpIdx < checkpoints.length && checkpoints[cpIdx]!.seq <= seq) {
        const cp = checkpoints[cpIdx]!;
        cpIdx++;
        if (cp.seq < seq) continue; // seq not present in range (handled as gap above)
        const key = d.macKeyFor(cp.key_id);
        if (!key || !verifyCheckpointMac(key, { seq: cp.seq, hash: cp.hash, kind: cp.kind as CheckpointKind, mac: cp.mac })) return fail(seq, r.id, 'bad_checkpoint_mac', null, cp.mac, checked, cpsVerified);
        if (cp.hash !== r.hash) return fail(seq, r.id, 'checkpoint_mismatch', cp.hash, r.hash, checked, cpsVerified);
        cpsVerified++;
      }
      expectedPrev = r.hash;
      nextSeq = seq + 1;
      checked++;
    }
    cursor = Number(rows[rows.length - 1]!.seq);
    await d.onProgress?.(checked);
    if (rows.length < pageSize) break;
  }
  if (nextSeq <= to) return fail(nextSeq, null, 'gap', String(nextSeq), null, checked, cpsVerified);
  if (range.toSeq === undefined) {
    // tail deletion: a checkpoint anchors a seq that no longer exists
    const beyond = await d.db.selectFrom('audit_checkpoints').select(['seq', 'hash']).where('seq', '>', to).orderBy('seq', 'desc').limit(1).executeTakeFirst();
    if (beyond) return fail(to + 1, null, 'gap', String(Number(beyond.seq)), String(to), checked, cpsVerified);
  }
  return { ok: true, checked, firstSeq: from, lastSeq: to, checkpointsVerified: cpsVerified, brokenAt: null };
}
