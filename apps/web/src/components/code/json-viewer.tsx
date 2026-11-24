import { useState, type ReactNode } from 'react';
import { ShieldIcon } from 'lucide-react';
import { isRedactedMarker } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Read-only JSON with syntax colours. Redaction markers `{ "$redacted": "rule" }` render as a
 * distinct `REDACTED · rule` pill; the raw value is never present in the payload or the DOM
 * (frontend §5.3).
 */
export function JsonViewer({ value, className, collapseAfter, label }: { value: unknown; className?: string; collapseAfter?: number; label?: string }) {
  const lines = renderLines(value);
  const [expanded, setExpanded] = useState(false);
  const limit = collapseAfter && !expanded && lines.length > collapseAfter ? collapseAfter : lines.length;
  return (
    <div className={cn('rounded-lg border bg-muted/40 font-mono text-[12.5px] leading-relaxed', className)}>
      <pre aria-label={label} className="overflow-x-auto p-3 whitespace-pre-wrap break-words">
        {lines.slice(0, limit).map((l, i) => (
          <div key={i}>{l}</div>
        ))}
      </pre>
      {limit < lines.length ? (
        <div className="border-t px-3 py-1.5">
          <Button variant="ghost" size="xs" onClick={() => setExpanded(true)}>
            Show {lines.length - limit} more lines
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function RedactedPill({ rule }: { rule: string }) {
  return (
    <span className="inline-flex h-5 items-center gap-1 rounded-full bg-muted px-2 align-middle font-sans text-[11.5px] font-medium text-muted-foreground">
      <ShieldIcon aria-hidden="true" className="size-3" />
      REDACTED · {rule}
    </span>
  );
}

const K = 'text-info';
const S = 'text-success';
const N = 'text-warning';
const L = 'text-chart-4';

function scalar(v: unknown): ReactNode {
  if (typeof v === 'string') return <span className={S}>{JSON.stringify(v)}</span>;
  if (typeof v === 'number') return <span className={N}>{String(v)}</span>;
  if (typeof v === 'boolean' || v === null) return <span className={L}>{String(v)}</span>;
  return <span>{JSON.stringify(v)}</span>;
}

/** Builds one React node per output line (indentation preserved). Exported for tests. */
export function renderLines(value: unknown): ReactNode[] {
  const out: ReactNode[] = [];
  const pad = (d: number) => '  '.repeat(d);
  function walk(v: unknown, depth: number, prefix: ReactNode, trailing: string) {
    if (isRedactedMarker(v)) {
      out.push(
        <>
          {pad(depth)}
          {prefix}
          <RedactedPill rule={v.$redacted} />
          {trailing}
        </>,
      );
      return;
    }
    if (Array.isArray(v)) {
      if (v.length === 0) {
        out.push(<>{pad(depth)}{prefix}[]{trailing}</>);
        return;
      }
      out.push(<>{pad(depth)}{prefix}[</>);
      v.forEach((item, i) => walk(item, depth + 1, null, i < v.length - 1 ? ',' : ''));
      out.push(<>{pad(depth)}]{trailing}</>);
      return;
    }
    if (v && typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>);
      if (entries.length === 0) {
        out.push(<>{pad(depth)}{prefix}{'{}'}{trailing}</>);
        return;
      }
      out.push(<>{pad(depth)}{prefix}{'{'}</>);
      entries.forEach(([k, item], i) => walk(item, depth + 1, <><span className={K}>{JSON.stringify(k)}</span>: </>, i < entries.length - 1 ? ',' : ''));
      out.push(<>{pad(depth)}{'}'}{trailing}</>);
      return;
    }
    out.push(<>{pad(depth)}{prefix}{scalar(v)}{trailing}</>);
  }
  walk(value, 0, null, '');
  return out;
}
