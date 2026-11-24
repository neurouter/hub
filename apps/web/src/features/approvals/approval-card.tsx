import { useId, useState } from 'react';
import { CheckIcon, ClockIcon, ShieldIcon } from 'lucide-react';
import { isRedactedMarker, type Approval } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { RedactedPill } from '@/components/code/json-viewer';
import { Pill } from '@/components/status/status';
import { formatTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { clientLabel, outcomeLabel, spokenRemaining, type Countdown, type Urgency } from './model';

const URGENCY_TEXT: Record<Urgency, string> = {
  normal: 'text-foreground',
  warning: 'text-warning',
  critical: 'text-destructive',
  expired: 'text-muted-foreground',
};
const URGENCY_BAR: Record<Urgency, string> = {
  normal: 'bg-foreground',
  warning: 'bg-warning',
  critical: 'bg-destructive',
  expired: 'bg-muted-foreground',
};

/** Prototype `p.v` rendering: strings quoted, numbers/booleans bare, objects compact JSON. */
function paramValue(v: unknown): { text: string; cls: string } {
  if (typeof v === 'string') return { text: JSON.stringify(v), cls: 'text-success' };
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return { text: String(v), cls: 'text-warning' };
  return { text: JSON.stringify(v), cls: 'text-foreground' };
}

/** Redacted input params as key/value rows (prototype "Input · redacted"); long lists collapse after 10. */
export function ParamsList({ params, compact }: { params: Record<string, unknown>; compact?: boolean }) {
  const entries = Object.entries(params);
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? entries : entries.slice(0, 10);
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border bg-muted/40 px-3.5 py-2.5">
      {!compact ? <span className="mb-1 text-[11.5px] font-semibold tracking-wide text-muted-foreground uppercase">Input · redacted</span> : null}
      {entries.length === 0 ? <span className="text-[13px] text-muted-foreground">No arguments</span> : null}
      <dl className="flex flex-col gap-0.5">
        {shown.map(([k, v]) => {
          const pv = paramValue(v);
          return (
            <div key={k} className="flex min-w-0 items-baseline gap-2.5 font-mono text-[12.5px]">
              <dt className={cn('shrink-0 text-info', compact ? '' : 'min-w-[120px]')}>{k}</dt>
              <dd className={cn('min-w-0', compact ? 'truncate' : 'break-words whitespace-pre-wrap')}>
                {isRedactedMarker(v) ? <RedactedPill rule={v.$redacted} /> : <span className={pv.cls}>{pv.text}</span>}
              </dd>
            </div>
          );
        })}
      </dl>
      {entries.length > shown.length ? (
        <Button variant="ghost" size="xs" className="mt-1 self-start" onClick={() => setExpanded(true)}>
          Show {entries.length - shown.length} more
        </Button>
      ) : null}
    </div>
  );
}

/**
 * One held call (prototype Approvals.dc.html / MobileApprovals.dc.html): tool, agent on behalf of
 * user, client, countdown with progress bar, redacted params, Approve / Deny with a required reason.
 */
export function ApprovalCard({
  approval: a, cd, compact, pending, onApprove, onDeny,
}: {
  approval: Approval;
  cd: Countdown;
  compact: boolean;
  pending: boolean;
  onApprove: () => void;
  onDeny: (reason: string) => void;
}) {
  const id = useId();
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState('');
  const outcome = a.status !== 'pending' ? outcomeLabel(a) : null;
  const expired = cd.urgency === 'expired';
  const locked = expired || !!outcome || pending;
  const canApprove = a.actions.includes('approve');
  const canDeny = a.actions.includes('deny');
  const bar = (
    <div
      role="progressbar"
      aria-label={`Time remaining for ${a.tool.qualifiedName}`}
      aria-valuemin={0}
      aria-valuemax={a.timeoutSec}
      aria-valuenow={cd.leftSec}
      aria-valuetext={spokenRemaining(cd.leftSec)}
      className={cn('overflow-hidden bg-muted', compact ? 'h-1 w-full' : 'h-1.5 w-[200px] rounded-full')}
    >
      <div className={cn('h-full', compact ? '' : 'rounded-full', URGENCY_BAR[cd.urgency])} style={{ width: `${cd.pct.toFixed(1)}%` }} />
    </div>
  );
  const approveButton = (
    <Button size={compact ? 'lg' : 'default'} disabled={locked || !canApprove} onClick={onApprove} aria-label={`Approve ${a.tool.qualifiedName}`}>
      <CheckIcon /> Approve
    </Button>
  );
  return (
    <article
      aria-labelledby={`${id}-tool`}
      data-urgency={cd.urgency}
      className={cn('overflow-hidden rounded-xl border bg-card shadow-xs', cd.urgency === 'critical' && !outcome ? 'border-destructive/40' : '')}
    >
      {compact ? bar : null}
      <div className={cn('flex flex-wrap items-start gap-4', compact ? 'px-3.5 pt-3 pb-2' : 'px-[18px] pt-4 pb-3')}>
        <div className="flex min-w-0 flex-[1_1_380px] flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id={`${id}-tool`} className={cn('font-mono font-semibold break-all', compact ? 'text-[13px]' : 'text-sm')}>
              {a.tool.qualifiedName}
            </h2>
            {!compact ? (
              <Pill tone="warn" icon={ShieldIcon}>
                Requires approval
              </Pill>
            ) : null}
          </div>
          {compact ? (
            <p className="text-[13px]">
              <b className="font-semibold">{a.agent.name}</b> <span className="text-muted-foreground">for</span> <b className="font-semibold">{a.user.name}</b>
            </p>
          ) : (
            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13.5px]">
              <span>
                Agent <span className="font-semibold">{a.agent.name}</span>
              </span>
              <span className="text-muted-foreground">on behalf of</span>
              <span className="font-semibold">{a.user.name}</span>
              <span className="text-muted-foreground">
                · {clientLabel(a)} · requested <time dateTime={a.createdAt}>{formatTime(a.createdAt)}</time>
              </span>
            </p>
          )}
        </div>
        <div className={cn('flex flex-col items-end gap-1.5', compact ? 'ml-auto' : 'flex-[0_0_200px]')}>
          <div className={cn('flex items-center gap-1.5', URGENCY_TEXT[cd.urgency])}>
            {!compact ? <ClockIcon aria-hidden="true" className="size-4" /> : null}
            <span aria-hidden="true" className={cn('font-semibold tracking-tight tabular-nums', compact ? 'text-[17px]' : 'text-[22px]')}>
              {cd.label}
            </span>
          </div>
          {!compact ? bar : null}
        </div>
      </div>
      <div className={compact ? 'px-3.5 pb-3' : 'px-[18px] pb-3.5'}>
        <ParamsList params={a.inputParams} compact={compact} />
      </div>
      {denying ? (
        <div className={cn('flex flex-col gap-1.5', compact ? 'px-3.5 pb-3' : 'px-[18px] pb-3.5')}>
          <label htmlFor={`${id}-reason`} className="text-[13px] font-medium">
            Reason for denying <span className="font-normal text-muted-foreground">(required, returned to the agent and audited)</span>
          </label>
          <Textarea
            id={`${id}-reason`}
            rows={2}
            maxLength={1000}
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Merges to payments-api are frozen until Thursday."
            className="resize-none"
          />
        </div>
      ) : null}
      <div className={cn('flex flex-wrap items-center gap-2 border-t bg-muted/60', compact ? 'px-3.5 py-2.5' : 'px-[18px] py-3')}>
        {outcome ? (
          <Pill tone={a.status === 'approved' ? 'ok' : a.status === 'denied' ? 'err' : 'muted'}>{outcome}</Pill>
        ) : expired ? (
          <Pill tone="muted">Expired · the agent received a timeout error</Pill>
        ) : null}
        <span className="flex-1" />
        <div className={cn('flex gap-2', compact ? 'grid w-full grid-cols-2' : '')}>
          {denying ? (
            <>
              <Button
                variant="ghost"
                size={compact ? 'lg' : 'default'}
                onClick={() => {
                  setDenying(false);
                  setReason('');
                }}
              >
                Cancel
              </Button>
              <Button variant="destructive" size={compact ? 'lg' : 'default'} disabled={locked || !reason.trim()} onClick={() => onDeny(reason.trim())} aria-label={`Deny call to ${a.tool.qualifiedName}`}>
                Deny call
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                size={compact ? 'lg' : 'default'}
                className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={locked || !canDeny}
                onClick={() => setDenying(true)}
                aria-label={`Deny ${a.tool.qualifiedName}`}
              >
                Deny…
              </Button>
              {!canApprove && canDeny ? (
                <Tooltip>
                  <TooltipTrigger render={<span tabIndex={0} />}>{approveButton}</TooltipTrigger>
                  <TooltipContent>You can't approve a call made on your own behalf.</TooltipContent>
                </Tooltip>
              ) : (
                approveButton
              )}
            </>
          )}
        </div>
      </div>
    </article>
  );
}
