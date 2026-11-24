import { cn } from '@/lib/utils';
import { lineDiff, type SplitRow, type WordPart } from '@/lib/diff';

const ROW = 'grid grid-cols-[2.5rem_1rem_1fr] font-mono text-[12.5px] leading-6';
const BG = { ctx: '', del: 'bg-destructive-muted', add: 'bg-success-muted' } as const;
const SIGN = { ctx: '', del: '−', add: '+' } as const;
const SIGN_COLOR = { ctx: '', del: 'text-destructive', add: 'text-success' } as const;

function Side({ cell, side }: { cell: SplitRow['left'] | SplitRow['right']; side: 'left' | 'right' }) {
  if (!cell) return <div className={cn(ROW, 'bg-muted/40')} aria-hidden="true">&nbsp;</div>;
  return (
    <div className={cn(ROW, BG[cell.kind])} data-kind={cell.kind} data-side={side}>
      <span className="pr-2 text-right text-muted-foreground select-none">{cell.n}</span>
      <span className={cn('select-none', SIGN_COLOR[cell.kind])} aria-hidden="true">
        {SIGN[cell.kind]}
      </span>
      <span className="whitespace-pre-wrap break-all">
        {cell.kind !== 'ctx' ? <span className="sr-only">{cell.kind === 'add' ? 'added: ' : 'removed: '}</span> : null}
        {cell.text}
      </span>
    </div>
  );
}

/** Line diff in split (side-by-side) or unified layout. */
export function DiffView({ oldText, newText, layout, labels = ['Pinned', 'New'] }: { oldText: string; newText: string; layout: 'split' | 'unified'; labels?: [string, string] }) {
  const d = lineDiff(oldText, newText);
  if (layout === 'unified') {
    return (
      <div className="overflow-x-auto rounded-lg border" role="group" aria-label="Unified diff">
        {d.unified.map((r, i) => (
          <div key={i} className={cn('grid grid-cols-[2.5rem_2.5rem_1rem_1fr] font-mono text-[12.5px] leading-6', BG[r.kind])} data-kind={r.kind}>
            <span className="pr-2 text-right text-muted-foreground select-none">{r.oldN ?? ''}</span>
            <span className="pr-2 text-right text-muted-foreground select-none">{r.newN ?? ''}</span>
            <span className={cn('select-none', SIGN_COLOR[r.kind])} aria-hidden="true">
              {SIGN[r.kind]}
            </span>
            <span className="whitespace-pre-wrap break-all">
              {r.kind !== 'ctx' ? <span className="sr-only">{r.kind === 'add' ? 'added: ' : 'removed: '}</span> : null}
              {r.text}
            </span>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 overflow-hidden rounded-lg border lg:grid-cols-2">
      <div className="min-w-0 border-b lg:border-r lg:border-b-0" aria-label={labels[0]}>
        {d.split.map((r, i) => (
          <Side key={i} cell={r.left} side="left" />
        ))}
      </div>
      <div className="min-w-0" aria-label={labels[1]}>
        {d.split.map((r, i) => (
          <Side key={i} cell={r.right} side="right" />
        ))}
      </div>
    </div>
  );
}

/** Word diff rendered inline: deletions struck through (red), additions highlighted (green). */
export function WordDiffText({ parts, side }: { parts: WordPart[]; side: 'old' | 'new' }) {
  return (
    <p className="text-[14px] leading-relaxed">
      {parts.map((p, i) => {
        if (p.kind === 'same') return <span key={i}>{p.text}</span>;
        if (side === 'old' && p.kind === 'del')
          return (
            <del key={i} className="rounded bg-destructive-muted px-0.5 text-destructive decoration-destructive/60">
              {p.text}
            </del>
          );
        if (side === 'new' && p.kind === 'add')
          return (
            <ins key={i} className="rounded bg-success-muted px-0.5 text-success no-underline">
              {p.text}
            </ins>
          );
        return null;
      })}
    </p>
  );
}
