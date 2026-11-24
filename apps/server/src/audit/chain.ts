import { canonicalJson } from '../lib/jcs.js';
import { hkdf, hmacSha256Hex, sha256Hex, timingSafeEqualStr } from '../lib/crypto.js';
import { createHash } from 'node:crypto';

/**
 * Pure hash-chain functions (backend §9.3).
 *
 *   genesis_prev = sha256("neurouter-audit-genesis:" + install_id)
 *   entry_body   = JCS({ seq, id, ts, kind, …, session_id, ip, user_agent })   // nulls explicit
 *   hash(n)      = hex(sha256(hexToBytes(prev_hash) || 0x1E || utf8(entry_body)))
 *   checkpoint   = { seq, hash, kind, key_id, mac: hex(HMAC-SHA256(auditMacKey, "ckpt|seq|hash|kind")) }
 */
export const CHAIN_FIELDS = [
  'seq', 'id', 'ts', 'kind', 'request_id', 'user_id', 'agent_id', 'api_key_id', 'oauth_client_id', 'client_name',
  'client_version', 'protocol_version', 'client_era', 'server_id', 'tool_id', 'tool_name', 'action', 'target_type',
  'target_id', 'decision', 'decision_reason', 'status', 'params_redacted', 'changes', 'output_size', 'output_hash',
  'output_full', 'latency_ms', 'upstream_latency_ms', 'error_code', 'error_message', 'trace_id', 'span_id',
  'session_id', 'ip', 'user_agent',
] as const;
export type ChainField = (typeof CHAIN_FIELDS)[number];
export type ChainEntry = { [K in ChainField]: unknown };

export type CheckpointKind = 'periodic' | 'retention_cut' | 'key_rotation';

const JSON_FIELDS = new Set<ChainField>(['params_redacted', 'changes', 'output_full']);
const INT_FIELDS = new Set<ChainField>(['seq', 'ts', 'output_size', 'latency_ms', 'upstream_latency_ms']);

export function genesisPrev(installId: string): string {
  return sha256Hex(`neurouter-audit-genesis:${installId}`);
}

/**
 * Normalizes a stored row (or a row about to be stored) into the exact value the chain covers:
 * JSON columns parsed (TEXT in SQLite, jsonb in PG), integers as numbers, missing values as null.
 */
export function chainEntry(row: Record<string, unknown>): ChainEntry {
  const out = {} as Record<ChainField, unknown>;
  for (const f of CHAIN_FIELDS) {
    let v = row[f];
    if (v === undefined) v = null;
    if (v !== null && JSON_FIELDS.has(f) && typeof v === 'string') v = JSON.parse(v) as unknown;
    if (v !== null && INT_FIELDS.has(f)) v = Number(v);
    out[f] = v;
  }
  return out as ChainEntry;
}

export function entryBody(row: Record<string, unknown>): string {
  return canonicalJson(chainEntry(row));
}

export function computeHash(prevHash: string, body: string): string {
  return createHash('sha256').update(Buffer.from(prevHash, 'hex')).update(Buffer.from([0x1e])).update(body, 'utf8').digest('hex');
}

export function hashRow(prevHash: string, row: Record<string, unknown>): string {
  return computeHash(prevHash, entryBody(row));
}

/** Audit MAC key, derived from a KEK (so DB write access alone can't forge checkpoints). */
export function auditMacKey(kek: Buffer): Buffer {
  return hkdf(kek, 'neurouter:audit-checkpoint-mac');
}

export function checkpointMac(macKey: Buffer, seq: number, hash: string, kind: CheckpointKind): string {
  return hmacSha256Hex(macKey, `ckpt|${seq}|${hash}|${kind}`);
}

export function verifyCheckpointMac(macKey: Buffer, cp: { seq: number; hash: string; kind: CheckpointKind; mac: string }): boolean {
  return timingSafeEqualStr(checkpointMac(macKey, Number(cp.seq), cp.hash, cp.kind), cp.mac);
}
