import { BadgeCheckIcon, CircleHelpIcon, OctagonAlertIcon, ShieldAlertIcon, ShieldQuestionIcon, TriangleAlertIcon, InfoIcon, type LucideIcon } from 'lucide-react';
import type { GradeConfidence, GradeFlag, LetterGrade, PublisherTrust, QualityGrade } from '@neurouter/shared';
import { Pill, type Tone } from '@/components/status/status';
import { cn } from '@/lib/utils';

const GRADE_TONE: Record<LetterGrade, string> = {
  A: 'border-success/40 bg-success-muted text-success',
  B: 'border-success/30 bg-success-muted/60 text-success',
  C: 'border-warning/30 bg-warning-muted text-warning',
  D: 'border-destructive/30 bg-destructive-muted/70 text-destructive',
  F: 'border-destructive/40 bg-destructive-muted text-destructive',
};

export const CONFIDENCE_LABEL: Record<GradeConfidence, string> = {
  low: 'Low confidence: based on registry metadata only. Run a check for a full grade.',
  medium: 'Medium confidence: some signals are still unknown.',
  high: 'High confidence: connection, definitions and repository data are known.',
};

/**
 * Letter grade A–F. Low confidence is drawn dashed and muted with a "?" so a preliminary grade
 * (registry metadata only) never looks as solid as a checked one; no grade at all is "Unrated".
 */
export function GradeBadge({ grade, confidence, size = 'md', className }: { grade: LetterGrade | null; confidence: GradeConfidence; size?: 'md' | 'lg'; className?: string }) {
  const dims = size === 'lg' ? 'size-12 text-2xl' : 'size-8 text-base';
  if (!grade) {
    return (
      <span title="Unrated: not enough data" className={cn('inline-flex shrink-0 items-center justify-center rounded-lg border border-dashed text-muted-foreground', dims, className)}>
        <span aria-hidden="true">–</span>
        <span className="sr-only">Unrated</span>
      </span>
    );
  }
  const low = confidence === 'low';
  return (
    <span
      title={`Grade ${grade}. ${CONFIDENCE_LABEL[confidence]}`}
      className={cn('relative inline-flex shrink-0 items-center justify-center rounded-lg border font-semibold tabular-nums', dims, GRADE_TONE[grade], low && 'border-dashed opacity-70', className)}
    >
      {grade}
      {low ? <span className="absolute -top-1.5 -right-1.5 rounded-full bg-background px-0.5 text-[10px] leading-none text-muted-foreground">?</span> : null}
      <span className="sr-only">{`, ${confidence} confidence`}</span>
    </span>
  );
}

const TRUST: Record<PublisherTrust, { tone: Tone; icon: LucideIcon; label: string }> = {
  verified: { tone: 'ok', icon: BadgeCheckIcon, label: 'Verified publisher' },
  known: { tone: 'info', icon: BadgeCheckIcon, label: 'Known publisher' },
  unverified: { tone: 'muted', icon: ShieldQuestionIcon, label: 'Unverified' },
  mismatch: { tone: 'warn', icon: ShieldAlertIcon, label: 'Domain mismatch' },
};

export function TrustBadge({ trust, reason }: { trust: PublisherTrust; reason?: string }) {
  const t = TRUST[trust];
  return (
    <Pill tone={t.tone} icon={t.icon} {...(reason ? { title: reason } : {})}>
      {t.label}
    </Pill>
  );
}

const FLAG: Record<GradeFlag['severity'], { tone: Tone; icon: LucideIcon; box: string }> = {
  danger: { tone: 'err', icon: OctagonAlertIcon, box: 'border-destructive/30 bg-destructive-muted text-destructive' },
  warn: { tone: 'warn', icon: TriangleAlertIcon, box: 'border-warning/30 bg-warning-muted text-warning' },
  info: { tone: 'info', icon: InfoIcon, box: 'border-info/30 bg-info-muted text-info' },
};

export function FlagPill({ flag }: { flag: GradeFlag }) {
  const f = FLAG[flag.severity];
  return (
    <Pill tone={f.tone} icon={f.icon} title={flag.message} className="max-w-full">
      <span className="truncate">{flag.message}</span>
    </Pill>
  );
}

export function FlagList({ flags }: { flags: GradeFlag[] }) {
  if (!flags.length) return null;
  return (
    <ul className="flex flex-col gap-2" aria-label="Warnings">
      {flags.map((flag) => {
        const f = FLAG[flag.severity];
        return (
          <li key={flag.code} className={cn('flex gap-2.5 rounded-lg border p-3', f.box)}>
            <f.icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <div className="flex flex-col gap-0.5 text-[13.5px] text-foreground">
              <span>{flag.message}</span>
              {flag.cap ? <span className="text-xs text-muted-foreground">Caps the grade at {flag.cap}.</span> : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Bar({ value }: { value: number | null }) {
  if (value === null) return <span className="text-xs text-muted-foreground">Unknown</span>;
  const pct = Math.round(value * 100);
  return (
    <span className="flex items-center gap-2">
      <span className="h-1.5 w-24 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <span className={cn('block h-full rounded-full', value >= 0.7 ? 'bg-success' : value >= 0.4 ? 'bg-warning' : 'bg-destructive')} style={{ width: `${pct}%` }} />
      </span>
      <span className="w-8 text-right text-xs tabular-nums">{pct}</span>
    </span>
  );
}

/** Every sub-score with the signals behind it. Unknown sub-scores are shown as such (left out of the grade). */
export function GradeBreakdown({ quality }: { quality: QualityGrade }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <GradeBadge grade={quality.grade} confidence={quality.confidence} size="lg" />
        <div className="flex flex-col gap-1 text-[13.5px]">
          <span className="font-medium">
            {quality.grade ? `Grade ${quality.grade}` : 'Unrated'}
            {quality.score !== null ? <span className="text-muted-foreground"> · {Math.round(quality.score * 100)} / 100</span> : null}
            {quality.uncappedGrade ? <span className="text-muted-foreground"> · {quality.uncappedGrade} before warnings</span> : null}
          </span>
          <span className="text-muted-foreground">{CONFIDENCE_LABEL[quality.confidence]}</span>
        </div>
      </div>
      <table className="w-full text-[13.5px]">
        <caption className="sr-only">Grade breakdown</caption>
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th className="pb-2 font-medium">Sub-score</th>
            <th className="pb-2 font-medium">Weight</th>
            <th className="pb-2 font-medium">Score</th>
          </tr>
        </thead>
        <tbody>
          {quality.subscores.map((s) => (
            <tr key={s.key} className="border-t align-top">
              <td className="py-2.5 pr-3">
                <div className="font-medium">{s.label}</div>
                {s.signals.length ? (
                  <ul className="mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground">
                    {s.signals.map((g) => (
                      <li key={g.label}>
                        {g.label}: <span className="text-foreground">{g.value}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="mt-1 text-xs text-muted-foreground">No data yet; left out of the grade.</div>
                )}
              </td>
              <td className="py-2.5 pr-3 tabular-nums text-muted-foreground">{s.weight}</td>
              <td className="py-2.5">
                <Bar value={s.score} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <CircleHelpIcon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
        Computed by rules, not by a model: the weighted mean of the known sub-scores, then capped by warnings. Algorithm v{quality.version}; sources: {quality.sources.join(', ') || 'none'}.
      </p>
    </div>
  );
}
