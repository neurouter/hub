import type { RequestContext } from './context.js';

export type ApprovalOutcome = { status: 'approved'; approverId: string; approvalId: string } | { status: 'denied' | 'timeout' | 'cancelled' | 'unavailable'; message: string; approvalId?: string };

export interface ApprovalHoldInput {
  requestId: string;
  toolId: string;
  serverId: string;
  toolName: string;
  args: Record<string, unknown>;
  /** Tool override; null → `approvalDefaultTimeoutSec` (always capped by `approvalMaxTimeoutSec`). */
  timeoutSec: number | null;
  signal: AbortSignal;
  client?: { name: string | null; version: string | null };
  /** Progress keep-alive for clients that sent a progressToken (backend §12.2: every 10 s). */
  progress?: (p: { progress: number; total: number; message: string }) => void;
  /** Called once the pending row exists (the pipeline audits `approval_pending`). */
  onPending?: (approval: { id: string; expiresAt: number; timeoutSec: number }) => void;
}

/** Human-approval hold for `requires_approval` tools (backend §12.2). */
export interface ApprovalGate {
  hold(rc: RequestContext, input: ApprovalHoldInput): Promise<ApprovalOutcome>;
}

/** Used only when no approval store is wired (never in the composed app). */
export const failClosedApprovals: ApprovalGate = {
  async hold() {
    return { status: 'unavailable', message: 'This tool requires human approval, which is not enabled on this gateway' };
  },
};
