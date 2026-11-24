import type { ReactNode } from 'react';
import { CopyButton } from './copy-button';

/** Snippet card: header (label + target), Copy, and the code block (prototype Connect). */
export function CodeSnippet({ code, label, target, footer }: { code: string; label?: ReactNode; target?: ReactNode; footer?: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-sm">
        {label ? <span className="font-medium">{label}</span> : null}
        {target ? <span className="font-mono text-[12.5px] text-muted-foreground">{target}</span> : null}
        <div className="flex-1" />
        <CopyButton value={code} label="Copy" variant="outline" size="sm" />
      </div>
      <pre className="overflow-x-auto bg-muted/40 p-4 font-mono text-[12.5px] leading-relaxed" data-testid="code-snippet">
        {code}
      </pre>
      {footer ? <div className="border-t px-3 py-2 text-[13px] text-muted-foreground">{footer}</div> : null}
    </div>
  );
}
