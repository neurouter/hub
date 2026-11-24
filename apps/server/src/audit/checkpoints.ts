import type { Kysely } from 'kysely';
import type { AuditDB } from '../db/schema.js';
import { newId } from '../lib/ids.js';
import { checkpointMac, type CheckpointKind } from './chain.js';
import type { AuditCheckpoint } from './types.js';

export interface MacSigner {
  keyId: string;
  key: Buffer;
}

export const CHECKPOINT_EVERY_ROWS = 10_000;
export const CHECKPOINT_EVERY_MS = 5 * 60_000;

/** Writes a checkpoint for `at` (a specific row) or for the current chain head. Null when the log is empty. */
export async function writeCheckpoint(db: Kysely<AuditDB>, kind: CheckpointKind, signer: MacSigner, now: number, at?: { seq: number; hash: string }): Promise<AuditCheckpoint | null> {
  let target = at;
  if (!target) {
    const head = await db.selectFrom('audit_log').select(['seq', 'hash']).orderBy('seq', 'desc').limit(1).executeTakeFirst();
    if (!head) return null;
    target = { seq: Number(head.seq), hash: head.hash };
  }
  const cp: AuditCheckpoint = { id: newId(), seq: target.seq, hash: target.hash, kind, mac: checkpointMac(signer.key, target.seq, target.hash, kind), keyId: signer.keyId, createdAt: now };
  await db.insertInto('audit_checkpoints').values({ id: cp.id, seq: cp.seq, hash: cp.hash, kind, mac: cp.mac, key_id: cp.keyId, created_at: now }).execute();
  return cp;
}

/** Periodic checkpoint (leader job): every 10,000 entries or 5 minutes, when the head moved. */
export async function maybePeriodicCheckpoint(db: Kysely<AuditDB>, signer: MacSigner, now: number, opts = { everyRows: CHECKPOINT_EVERY_ROWS, everyMs: CHECKPOINT_EVERY_MS }): Promise<AuditCheckpoint | null> {
  const head = await db.selectFrom('audit_log').select(['seq', 'hash']).orderBy('seq', 'desc').limit(1).executeTakeFirst();
  if (!head) return null;
  const last = await db.selectFrom('audit_checkpoints').select(['seq', 'created_at']).orderBy('seq', 'desc').orderBy('created_at', 'desc').limit(1).executeTakeFirst();
  const headSeq = Number(head.seq);
  if (last && Number(last.seq) >= headSeq) return null;
  const due = !last || headSeq - Number(last.seq) >= opts.everyRows || now - Number(last.created_at) >= opts.everyMs;
  return due ? writeCheckpoint(db, 'periodic', signer, now, { seq: headSeq, hash: head.hash }) : null;
}

export function toCheckpoint(r: { id: string; seq: number; hash: string; kind: CheckpointKind; mac: string; key_id: string; created_at: number }): AuditCheckpoint {
  return { id: r.id, seq: Number(r.seq), hash: r.hash, kind: r.kind, mac: r.mac, keyId: r.key_id, createdAt: Number(r.created_at) };
}
