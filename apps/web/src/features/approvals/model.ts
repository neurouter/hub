import type { QueryClient } from '@tanstack/react-query';
import { Approval, type ApprovalStreamEvent, type Page } from '@neurouter/shared';
import { authKeys } from '@/features/auth/queries';

/* ------------------------------------------------------------------ countdown */

export type Urgency = 'normal' | 'warning' | 'critical' | 'expired';

export interface Countdown {
  leftSec: number;
  /** "m:ss" or "Expired" */
  label: string;
  /** 0–100, share of the hold time left (progress bar width) */
  pct: number;
  urgency: Urgency;
}

/** "4:07". */
export function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "3 minutes 20 seconds left" for the progressbar's aria-valuetext. */
export function spokenRemaining(sec: number): string {
  if (sec <= 0) return 'Expired';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  const parts = [m ? `${m} minute${m === 1 ? '' : 's'}` : '', s ? `${s} second${s === 1 ? '' : 's'}` : ''].filter(Boolean);
  return `${parts.join(' ')} left`;
}

/**
 * Remaining hold time from `expiresAt` and the server clock (§5.2): warning under 60 s,
 * critical under 15 s, expired at 0 (buttons disable and the card waits for the server event).
 */
export function countdown(expiresAt: string, timeoutSec: number, serverNowMs: number): Countdown {
  const leftMs = Date.parse(expiresAt) - serverNowMs;
  const leftSec = leftMs > 0 ? Math.ceil(leftMs / 1000) : 0;
  const total = Math.max(1, timeoutSec);
  const urgency: Urgency = leftSec <= 0 ? 'expired' : leftSec < 15 ? 'critical' : leftSec < 60 ? 'warning' : 'normal';
  return {
    leftSec,
    label: urgency === 'expired' ? 'Expired' : formatClock(leftSec),
    pct: Math.min(100, (leftSec / total) * 100),
    urgency,
  };
}

/** Screen-reader thresholds (§8): announce only when crossing 60 s and 15 s. */
export function crossedThreshold(prevSec: number | undefined, nextSec: number): 60 | 15 | null {
  if (prevSec === undefined) return null;
  if (prevSec > 15 && nextSec <= 15 && nextSec > 0) return 15;
  if (prevSec > 60 && nextSec <= 60 && nextSec > 15) return 60;
  return null;
}

/* ------------------------------------------------------------------ display helpers */

/** Client label (addendum #5): an API-key call shows the agent name plus "API key" (and the key's name when known). */
export function clientLabel(a: Pick<Approval, 'authMethod' | 'client' | 'agent'> & { apiKey?: Approval['apiKey'] }): string {
  if (a.authMethod === 'api_key') return a.apiKey ? `API key “${a.apiKey.name}” · ${a.agent.name}` : `API key · ${a.agent.name}`;
  if (!a.client) return 'OAuth client';
  return a.client.version ? `${a.client.name} ${a.client.version}` : a.client.name;
}

/** Outcome line for a card that was resolved elsewhere (shown briefly before it leaves). */
export function outcomeLabel(a: Pick<Approval, 'status' | 'decidedBy'>): string | null {
  switch (a.status) {
    case 'approved':
      return a.decidedBy ? `Approved by ${a.decidedBy.name}` : 'Approved';
    case 'denied':
      return a.decidedBy ? `Denied by ${a.decidedBy.name}` : 'Denied';
    case 'expired':
      return 'Expired · the agent received a timeout error';
    case 'cancelled':
    case 'abandoned':
      return 'Cancelled by the client';
    default:
      return null;
  }
}

export function sortBySoonestExpiry(items: readonly Approval[]): Approval[] {
  return [...items].sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
}

/** Time from request to decision, ms (Recent decisions). */
export function decisionLatencyMs(a: Pick<Approval, 'createdAt' | 'decidedAt'>): number | null {
  if (!a.decidedAt) return null;
  return Math.max(0, Date.parse(a.decidedAt) - Date.parse(a.createdAt));
}

/* ------------------------------------------------------------------ cache */

export type ApprovalPage = Page<Approval>;

export const approvalKeys = {
  all: ['approvals'] as const,
  lists: () => [...approvalKeys.all, 'list'] as const,
  status: (status: 'pending' | 'resolved') => [...approvalKeys.lists(), status] as const,
  list: (status: 'pending' | 'resolved', f: { limit?: number; mine?: boolean } = {}) => [...approvalKeys.status(status), f] as const,
};

export function upsertApproval(page: ApprovalPage | undefined, a: Approval): ApprovalPage | undefined {
  if (!page) return page;
  const i = page.items.findIndex((x) => x.id === a.id);
  if (i === -1) return { ...page, items: [a, ...page.items] };
  const items = page.items.slice();
  items[i] = a;
  return { ...page, items };
}

export function removeApproval(page: ApprovalPage | undefined, id: string): ApprovalPage | undefined {
  if (!page || !page.items.some((x) => x.id === id)) return page;
  return { ...page, items: page.items.filter((x) => x.id !== id) };
}

/** Replace in place only if present (a resolved event for a card we already removed is a no-op). */
export function replaceIfPresent(page: ApprovalPage | undefined, a: Approval): ApprovalPage | undefined {
  if (!page || !page.items.some((x) => x.id === a.id)) return page;
  return upsertApproval(page, a);
}

/** How long a card resolved elsewhere stays visible with its outcome (§5.2: "for 3 s, then leaves"). */
export const LINGER_MS = 3000;

/**
 * Applies one SSE event to the cache (§6.4): created → insert into Pending; resolved/expired →
 * the card shows the outcome, then leaves after LINGER_MS. Badges and Recent decisions refetch.
 * Returns the parsed approval, or null for a frame that does not match the contract.
 */
export function applyApprovalEvent(
  qc: QueryClient,
  type: ApprovalStreamEvent,
  data: unknown,
  schedule: (fn: () => void, ms: number) => void = (fn, ms) => void setTimeout(fn, ms),
): Approval | null {
  const parsed = Approval.safeParse(data);
  if (!parsed.success) return null;
  const a = parsed.data;
  if (type === 'approval.created') {
    if (a.status === 'pending') qc.setQueriesData<ApprovalPage>({ queryKey: approvalKeys.status('pending') }, (p) => upsertApproval(p, a));
  } else {
    qc.setQueriesData<ApprovalPage>({ queryKey: approvalKeys.status('pending') }, (p) => replaceIfPresent(p, a));
    schedule(() => qc.setQueriesData<ApprovalPage>({ queryKey: approvalKeys.status('pending') }, (p) => removeApproval(p, a.id)), LINGER_MS);
    void qc.invalidateQueries({ queryKey: approvalKeys.status('resolved') });
  }
  void qc.invalidateQueries({ queryKey: authKeys.badges });
  return a;
}
