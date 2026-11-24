import type { ReactNode } from 'react';
import {
  BanIcon, CheckCheckIcon, CheckIcon, CircleDashedIcon, CircleIcon, ClockIcon, MinusIcon, TriangleAlertIcon, XIcon, type LucideIcon,
} from 'lucide-react';
import {
  isBlockedDecision, type AccessRequestStatus, type ApiKeyStatus, type AuditDecision, type AuditStatus, type GrantEffect, type HealthStatus,
  type ToolReviewState,
} from '@neurouter/shared';
import { cn } from '@/lib/utils';
import { formatDuration } from '@/lib/format';

/**
 * Status pills matching the prototype's `badge b-ok|b-warn|b-err|b-info|b-mut` classes.
 * Status is never colour-only: every pill has an icon and text (frontend §7, §8).
 */
export type Tone = 'ok' | 'warn' | 'err' | 'info' | 'muted' | 'outline';

const TONE: Record<Tone, string> = {
  ok: 'border-success/30 bg-success-muted text-success',
  warn: 'border-warning/30 bg-warning-muted text-warning',
  err: 'border-destructive/30 bg-destructive-muted text-destructive',
  info: 'border-info/30 bg-info-muted text-info',
  muted: 'border-transparent bg-muted text-muted-foreground',
  outline: 'border-border bg-background text-foreground',
};

export function Pill({ tone = 'muted', icon: Icon, children, className, title }: { tone?: Tone; icon?: LucideIcon | undefined; children: ReactNode; className?: string; title?: string }) {
  return (
    <span
      data-tone={tone}
      title={title}
      className={cn('inline-flex h-[22px] w-fit shrink-0 items-center gap-1 rounded-full border px-2 text-xs font-medium whitespace-nowrap [&>svg]:size-3', TONE[tone], className)}
    >
      {Icon ? <Icon aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

/* ------------------------------------------------------------ audit decision / status */

const DECISION: Record<AuditDecision, { tone: Tone; icon: LucideIcon; label: string; detail?: string }> = {
  allowed: { tone: 'ok', icon: CheckIcon, label: 'allowed' },
  approved: { tone: 'ok', icon: CheckCheckIcon, label: 'approved by human' },
  denied_acl: { tone: 'err', icon: BanIcon, label: 'blocked', detail: 'Denied by access control' },
  denied_disabled: { tone: 'err', icon: BanIcon, label: 'blocked', detail: 'Tool or server disabled' },
  denied_rate_limit: { tone: 'err', icon: BanIcon, label: 'blocked', detail: 'Rate limited' },
  approval_pending: { tone: 'warn', icon: ClockIcon, label: 'approval pending' },
  approval_approved: { tone: 'ok', icon: CheckCheckIcon, label: 'approval approved' },
  approval_denied: { tone: 'err', icon: BanIcon, label: 'approval denied' },
  approval_timeout: { tone: 'muted', icon: ClockIcon, label: 'approval timeout' },
  approval_cancelled: { tone: 'muted', icon: XIcon, label: 'approval cancelled' },
  not_applicable: { tone: 'muted', icon: MinusIcon, label: 'n/a' },
};

export function decisionLabel(d: AuditDecision): string {
  const def = DECISION[d];
  return def.detail ? `${def.label} · ${def.detail.toLowerCase()}` : def.label;
}

export function DecisionBadge({ decision, reason }: { decision: AuditDecision; reason?: string | null }) {
  const def = DECISION[decision];
  return (
    <Pill tone={def.tone} icon={def.icon} title={reason ?? def.detail}>
      {def.label}
    </Pill>
  );
}

const STATUS: Record<AuditStatus, { tone: 'ok' | 'err' | 'warn' | 'muted'; label: string }> = {
  ok: { tone: 'ok', label: 'success' },
  tool_error: { tone: 'err', label: 'error' },
  upstream_error: { tone: 'err', label: 'upstream_error' },
  timeout: { tone: 'warn', label: 'timeout' },
  cancelled: { tone: 'muted', label: 'cancelled' },
  blocked: { tone: 'muted', label: '—' },
  invalid_args: { tone: 'err', label: 'invalid_args' },
};
const STATUS_TEXT: Record<'ok' | 'err' | 'warn' | 'muted', string> = {
  ok: 'text-success',
  err: 'text-destructive',
  warn: 'text-warning',
  muted: 'text-muted-foreground',
};

/** Status as coloured text with a leading dot (prototype audit table). */
export function AuditStatusText({ status }: { status: AuditStatus }) {
  const def = STATUS[status];
  if (status === 'blocked') return <span className="text-muted-foreground">—</span>;
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-[13px]', STATUS_TEXT[def.tone])}>
      <CircleIcon aria-hidden="true" className="size-2 fill-current" />
      {def.label}
    </span>
  );
}

export function auditStatusLabel(s: AuditStatus): string {
  return STATUS[s].label;
}

export { isBlockedDecision };

/* ------------------------------------------------------------ health */

const HEALTH: Record<HealthStatus, { tone: Tone; label: string; dot: string }> = {
  up: { tone: 'ok', label: 'Healthy', dot: 'bg-success' },
  degraded: { tone: 'warn', label: 'Degraded', dot: 'bg-warning' },
  down: { tone: 'err', label: 'Down', dot: 'bg-destructive' },
  unknown: { tone: 'muted', label: 'Unknown', dot: 'bg-muted-foreground' },
};

export function HealthDot({ status, className }: { status: HealthStatus; className?: string }) {
  return <span aria-hidden="true" className={cn('inline-block size-2 shrink-0 rounded-full', HEALTH[status].dot, className)} />;
}

export function healthLabel(status: HealthStatus, latencyMs?: number | null): string {
  return latencyMs !== null && latencyMs !== undefined && status !== 'down' && status !== 'unknown' ? `${HEALTH[status].label} · ${formatDuration(latencyMs)}` : HEALTH[status].label;
}

export function HealthBadge({ status, latencyMs }: { status: HealthStatus; latencyMs?: number | null }) {
  return (
    <Pill tone={HEALTH[status].tone}>
      <HealthDot status={status} />
      {healthLabel(status, latencyMs)}
    </Pill>
  );
}

/* ------------------------------------------------------------ grants / review / keys / requests */

export function EffectBadge({ effect }: { effect: GrantEffect }) {
  return effect === 'allow' ? (
    <Pill tone="ok" icon={CheckIcon}>
      Allow
    </Pill>
  ) : (
    <Pill tone="err" icon={BanIcon}>
      Deny
    </Pill>
  );
}

export function ReviewStateBadge({ state }: { state: ToolReviewState }) {
  if (state === 'approved') return <Pill tone="muted" icon={CheckIcon}>Approved</Pill>;
  if (state === 'rejected') return <Pill tone="err" icon={BanIcon}>Rejected</Pill>;
  return (
    <Pill tone="warn" icon={TriangleAlertIcon}>
      Pending review
    </Pill>
  );
}

export function KeyStatusBadge({ status }: { status: ApiKeyStatus }) {
  if (status === 'active') return <Pill tone="ok" icon={CheckIcon}>Active</Pill>;
  if (status === 'expired') return <Pill tone="warn" icon={ClockIcon}>Expired</Pill>;
  return <Pill tone="muted" icon={XIcon}>Revoked</Pill>;
}

const REQUEST: Record<AccessRequestStatus, { tone: Tone; icon: LucideIcon; label: string }> = {
  pending: { tone: 'warn', icon: CircleDashedIcon, label: 'Pending' },
  approved: { tone: 'ok', icon: CheckIcon, label: 'Approved' },
  denied: { tone: 'err', icon: BanIcon, label: 'Denied' },
  cancelled: { tone: 'muted', icon: XIcon, label: 'Cancelled' },
};

export function RequestStatusBadge({ status }: { status: AccessRequestStatus }) {
  const d = REQUEST[status];
  return (
    <Pill tone={d.tone} icon={d.icon}>
      {d.label}
    </Pill>
  );
}
