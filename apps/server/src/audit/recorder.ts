import type { Logger } from 'pino';
import type { AuditDecision, AuditStatus } from '@neurouter/shared';
import type { Clock } from '../lib/clock.js';
import { newId } from '../lib/ids.js';
import type { AuditEventInput, AuditStore } from './store.js';

export interface AdminAuditInput {
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  /** Server the change belongs to (owner-scoped audit). Derived for server/tool/grant targets when omitted. */
  serverId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuthAuditInput {
  userId: string | null;
  action: string;
  decision?: AuditDecision;
  status?: AuditStatus;
  reason?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Producer-side facade over AuditStore (non-blocking). `record()` returns false when the store
 * refused the event (queue full with `auditFailClosed`); the gateway checks `canAccept()` before
 * a tool call and fails closed (backend §9.1).
 */
export class AuditRecorder {
  constructor(
    private readonly store: AuditStore,
    private readonly clock: Clock,
    private readonly log: Pick<Logger, 'debug' | 'warn'>,
  ) {}

  /** Returns false when the store refused the event (queue full, fail-closed). */
  record(event: Omit<AuditEventInput, 'id' | 'ts'> & { id?: string; ts?: number }): boolean {
    const full: AuditEventInput = { ...event, id: event.id ?? newId(), ts: event.ts ?? this.clock.now() };
    try {
      return this.store.record(full);
    } catch (err) {
      this.log.warn({ err }, 'audit record failed');
      return false;
    }
  }

  /** False when tool calls must fail closed because audit can't be persisted. */
  canAccept(): boolean {
    return this.store.canAccept();
  }

  admin(e: AdminAuditInput): void {
    this.record({
      kind: 'admin',
      userId: e.actorUserId,
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId,
      serverId: e.serverId ?? (e.targetType === 'server' ? e.targetId : null),
      decision: 'not_applicable',
      status: 'ok',
      changes: e.before === undefined && e.after === undefined ? null : { before: e.before ?? null, after: e.after ?? null },
      ip: e.ip ?? null,
      userAgent: e.userAgent ?? null,
    });
  }

  auth(e: AuthAuditInput): void {
    this.record({
      kind: 'auth',
      userId: e.userId,
      action: e.action,
      decision: e.decision ?? 'not_applicable',
      status: e.status ?? 'ok',
      decisionReason: e.reason ?? null,
      ip: e.ip ?? null,
      userAgent: e.userAgent ?? null,
    });
  }

  system(action: string, details: { targetType?: string; targetId?: string; reason?: string; changes?: unknown } = {}): void {
    this.record({
      kind: 'system',
      action,
      targetType: details.targetType ?? null,
      targetId: details.targetId ?? null,
      decision: 'not_applicable',
      status: 'ok',
      decisionReason: details.reason ?? null,
      changes: details.changes === undefined ? null : { before: null, after: details.changes },
    });
  }
}
