import { useState } from 'react';
import { BookOpenIcon, ChevronDownIcon, ChevronRightIcon, GlobeIcon, RepeatIcon, TriangleAlertIcon } from 'lucide-react';
import type { LibraryCheck, LibraryCheckTool } from '@neurouter/shared';
import { Input } from '@/components/ui/input';
import { Pill } from '@/components/status/status';
import { cn } from '@/lib/utils';

function ScorePill({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  return (
    <Pill tone={score >= 0.85 ? 'ok' : score >= 0.55 ? 'warn' : 'err'} title="Definition quality from the lint (0–100)">
      {pct}
    </Pill>
  );
}

/** Upstream behaviour hints. They are claims by the server, shown as such (they never drive policy). */
function Hints({ a }: { a: LibraryCheckTool['annotations'] }) {
  return (
    <>
      {a.readOnlyHint === true ? <Pill tone="info" icon={BookOpenIcon}>Read-only</Pill> : null}
      {a.destructiveHint === true ? <Pill tone="err" icon={TriangleAlertIcon}>Destructive</Pill> : null}
      {a.idempotentHint === true ? <Pill tone="muted" icon={RepeatIcon}>Idempotent</Pill> : null}
      {a.openWorldHint === true ? <Pill tone="muted" icon={GlobeIcon}>Open world</Pill> : null}
    </>
  );
}

function ToolItem({ t }: { t: LibraryCheckTool }) {
  const [open, setOpen] = useState(false);
  const long = t.description.length > 280 || t.description.split('\n').length > 4;
  return (
    <li className="flex flex-col gap-2 p-4">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <span className="font-mono text-[13px] font-semibold break-all">{t.name}</span>
        {t.title && t.title !== t.name ? <span className="text-[13.5px] text-muted-foreground">{t.title}</span> : null}
        <span className="ml-auto flex flex-wrap gap-1.5">
          <Hints a={t.annotations} />
          <ScorePill score={t.score} />
        </span>
      </div>
      {t.description ? (
        <div>
          <p className={cn('text-[13.5px] whitespace-pre-line', !open && long && 'line-clamp-4')}>{t.description}</p>
          {long ? (
            <button type="button" className="mt-1 text-xs text-muted-foreground underline-offset-4 hover:underline" onClick={() => setOpen(!open)}>
              {open ? 'Show less' : 'Show more'}
            </button>
          ) : null}
        </div>
      ) : (
        <p className="text-[13.5px] text-muted-foreground italic">No description.</p>
      )}
      {t.params.length ? (
        <table className="w-full table-fixed text-[12.5px]">
          <caption className="sr-only">Parameters of {t.name}</caption>
          <thead className="text-left text-[11.5px] text-muted-foreground">
            <tr>
              <th className="w-1/4 py-1 pr-3 font-medium">Parameter</th>
              <th className="w-1/5 py-1 pr-3 font-medium">Type</th>
              <th className="py-1 font-medium">Description</th>
            </tr>
          </thead>
          <tbody>
            {t.params.map((p) => (
              <tr key={p.name} className="border-t align-top">
                <td className="py-1.5 pr-3 font-mono break-all">
                  {p.name}
                  {p.required ? <span className="text-destructive" title="Required"> *</span> : null}
                </td>
                <td className="py-1.5 pr-3 font-mono break-words text-muted-foreground">{p.type}</td>
                <td className="py-1.5">{p.description ?? <span className="text-muted-foreground italic">No description</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-xs text-muted-foreground">No parameters.</p>
      )}
      {t.issues.length ? <p className="text-xs text-warning">{t.issues.join(' · ')}</p> : null}
    </li>
  );
}

/** The tools a check listed, with descriptions, parameters, behaviour hints and lint notes. */
export function ToolList({ check }: { check: LibraryCheck | null }) {
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const conn = check?.connection;
  if (!check) return <p className="text-[13.5px] text-muted-foreground">Run a check to see this server's tools.</p>;
  if (!conn?.ok) {
    return (
      <p className="text-[13.5px] text-muted-foreground">
        {conn?.authRequired
          ? "This server requires sign-in before it lists its tools. Add it to the gateway to see and review them; they'll wait for approval."
          : conn?.paymentRequired
            ? 'This server asks for payment (HTTP 402) before it lists its tools.'
            : 'The last check could not list the tools.'}
      </p>
    );
  }
  const term = q.trim().toLowerCase();
  const tools = term ? check.tools.filter((t) => `${t.name} ${t.title ?? ''} ${t.description}`.toLowerCase().includes(term)) : check.tools;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="inline-flex items-center gap-1 text-[13px] font-medium" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? <ChevronRightIcon className="size-4" aria-hidden="true" /> : <ChevronDownIcon className="size-4" aria-hidden="true" />}
          {check.tools.length} tool{check.tools.length === 1 ? '' : 's'}
        </button>
        {check.tools.length > 6 && !collapsed ? <Input type="search" aria-label="Filter tools" placeholder="Filter tools…" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 max-w-60" /> : null}
      </div>
      {collapsed ? null : tools.length ? (
        <ul className="flex flex-col divide-y rounded-lg border" aria-label="Tools">
          {tools.map((t) => (
            <ToolItem key={t.name} t={t} />
          ))}
        </ul>
      ) : (
        <p className="text-[13.5px] text-muted-foreground">No tools match.</p>
      )}
    </div>
  );
}
