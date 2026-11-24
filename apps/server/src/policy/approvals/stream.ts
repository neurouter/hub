import type { Approval, ApprovalStreamEvent } from '@neurouter/shared';
import type { CoordinationStore, Unsubscribe } from '../../coordination/types.js';
import type { UserSubject } from '../../identity/principal.js';
import { fromIso } from '../../lib/clock.js';
import { APPROVALS_CHANGED, canSeeApproval, type ApprovalsService } from './approvals.service.js';

export interface ApprovalStreamSink {
  viewer: UserSubject;
  send(event: ApprovalStreamEvent, id: string, data: Approval): void;
}

/** `approval.created | approval.resolved | approval.expired` for a status (§12.2, D3). */
export function streamEventFor(status: Approval['status']): ApprovalStreamEvent {
  if (status === 'pending') return 'approval.created';
  if (status === 'approved' || status === 'denied') return 'approval.resolved';
  return 'approval.expired';
}

/** SSE event id: `<updatedAtMs>:<approvalId>` (replay cursor for `Last-Event-ID`). */
export function streamEventId(updatedAtMs: number, id: string): string {
  return `${updatedAtMs}:${id}`;
}

export function parseLastEventId(v: string | undefined | null): { ms: number; id: string } | null {
  const m = /^(\d{1,16}):([0-9a-zA-Z-]{1,64})$/.exec(v?.trim() ?? '');
  return m ? { ms: Number(m[1]), id: m[2]! } : null;
}

/** SSE wire format. */
export function sseFrame(event: string, id: string, data: unknown): string {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Per-replica fan-out of approval changes to SSE connections (backend §12.2). One coordination
 * subscription to `approvals.changed` (published by whichever replica changed the row); each
 * change is loaded once and sent to every connection whose viewer may see it, mapped per viewer
 * (the `actions` field differs).
 */
export class ApprovalStreamHub {
  private readonly sinks = new Set<ApprovalStreamSink>();
  private unsubscribe: Unsubscribe | null = null;

  constructor(
    private readonly coord: CoordinationStore,
    private readonly approvals: ApprovalsService,
    private readonly log: { warn: (o: object, m: string) => void },
  ) {}

  get size(): number {
    return this.sinks.size;
  }

  /** Adds a connection; replays changes after `lastEventId` first. Returns the remover. */
  async connect(sink: ApprovalStreamSink, lastEventId?: string | null): Promise<() => void> {
    const after = parseLastEventId(lastEventId);
    if (after) {
      for (const a of await this.approvals.changedSince(sink.viewer, after.ms, after.id)) this.emit(sink, a);
    }
    this.sinks.add(sink);
    this.unsubscribe ??= this.coord.subscribe(APPROVALS_CHANGED, (p) => {
      const id = (p as { id?: unknown } | null)?.id;
      if (typeof id === 'string') void this.deliver(id).catch((err: unknown) => this.log.warn({ err, id }, 'approval stream delivery failed'));
    });
    return () => {
      this.sinks.delete(sink);
      if (!this.sinks.size && this.unsubscribe) {
        this.unsubscribe();
        this.unsubscribe = null;
      }
    };
  }

  private emit(sink: ApprovalStreamSink, a: Approval & { updatedAtMs?: number }): void {
    const updated = a.updatedAtMs ?? (a.decidedAt ? fromIso(a.decidedAt) : fromIso(a.createdAt));
    const { updatedAtMs: _drop, ...data } = a;
    sink.send(streamEventFor(a.status), streamEventId(updated, a.id), data);
  }

  async deliver(id: string): Promise<void> {
    if (!this.sinks.size) return;
    const row = await this.approvals.row(id);
    if (!row) return;
    for (const sink of this.sinks) {
      if (!canSeeApproval(sink.viewer, row)) continue;
      const [a] = await this.approvals.toApi([row], sink.viewer);
      if (a) this.emit(sink, { ...a, updatedAtMs: Number(row.updated_at) });
    }
  }

  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.sinks.clear();
  }
}
