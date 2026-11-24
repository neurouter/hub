import type { AuditDecision, AuditKind, AuditStatus } from '@neurouter/shared';
import type { AuditLogTable } from '../db/schema.js';
import type { CheckpointKind } from './chain.js';

/** One audit event as produced by the gateway / admin routes (before redaction and chaining). */
export interface AuditEventInput {
  id: string;
  ts: number;
  kind: AuditKind;
  requestId?: string | null;
  userId?: string | null;
  agentId?: string | null;
  apiKeyId?: string | null;
  oauthClientId?: string | null;
  clientName?: string | null;
  clientVersion?: string | null;
  protocolVersion?: string | null;
  clientEra?: string | null;
  serverId?: string | null;
  toolId?: string | null;
  toolName?: string | null;
  action?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  decision: AuditDecision;
  decisionReason?: string | null;
  status: AuditStatus;
  params?: unknown;
  changes?: { before: unknown; after: unknown } | null;
  output?: unknown;
  latencyMs?: number | null;
  upstreamLatencyMs?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  traceId?: string | null;
  spanId?: string | null;
  sessionKey?: { source: 'client' | 'trace' | 'legacy' | 'idle_gap'; externalKey: string } | null;
  ip?: string | null;
  userAgent?: string | null;
}

/** Search filters (addendum 4: a time range is always required). Ids are already scope-checked. */
export interface AuditQuery {
  /** epoch ms, inclusive */
  from: number;
  /** epoch ms, exclusive */
  to: number;
  userId?: string;
  agentId?: string;
  /** Restricts to these servers (explicit filter and/or the owner's forced scope). Empty = no rows. */
  serverIds?: readonly string[];
  toolId?: string;
  decisions?: readonly AuditDecision[];
  statuses?: readonly AuditStatus[];
  kinds?: readonly AuditKind[];
  /** Full-text query over the bounded FTS fields. */
  q?: string;
  sessionId?: string;
  traceId?: string;
  /** keyset cursor: rows strictly after this seq in the chosen order */
  cursorSeq?: number | null;
  limit: number;
  order?: 'asc' | 'desc';
}

/** A stored audit row (JSON columns are raw: TEXT on SQLite, objects on PG). */
export type AuditRow = AuditLogTable;

export interface AuditCheckpoint {
  id: string;
  seq: number;
  hash: string;
  kind: CheckpointKind;
  mac: string;
  keyId: string;
  createdAt: number;
}

export type BrokenReason = 'hash_mismatch' | 'gap' | 'bad_checkpoint_mac' | 'checkpoint_mismatch' | 'broken_link';

export interface AuditVerifyOutcome {
  ok: boolean;
  checked: number;
  firstSeq: number | null;
  lastSeq: number | null;
  checkpointsVerified: number;
  brokenAt: { seq: number; eventId: string | null; reason: BrokenReason; expected: string | null; actual: string | null } | null;
}

export interface RetentionOutcome {
  cutoff: number;
  /** last seq removed (the retention_cut checkpoint), or null when nothing was due */
  cutSeq: number | null;
  deleted: number;
  archived: boolean;
  /** true when archive was configured and failed, so nothing was deleted */
  skipped: boolean;
  sessionsDeleted: number;
  partitionsDropped: number;
}

export interface DecisionCount {
  decision: AuditDecision;
  reason: string | null;
  count: number;
}

export interface AuditStats {
  queueDepth: number;
  dropped: number;
  lastError: string | null;
}
