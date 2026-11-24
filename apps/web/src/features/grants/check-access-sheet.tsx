import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BanIcon, CheckIcon, CircleHelpIcon, SearchCheckIcon } from 'lucide-react';
import type { AccessDecision, EffectiveReason } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/feedback/states';
import { EntityPicker, type PickerOption } from '@/components/filters/entity-picker';
import { Segmented } from '@/components/filters/segmented';
import { Pill } from '@/components/status/status';
import { pickerSearch } from '../pickers';
import { describeVia } from './matrix';
import { effectiveAccessQuery } from './queries';

const DECISION: Record<AccessDecision, { tone: 'ok' | 'err' | 'muted'; label: string; icon: typeof CheckIcon }> = {
  allow: { tone: 'ok', label: 'Allowed', icon: CheckIcon },
  deny: { tone: 'err', label: 'Denied', icon: BanIcon },
  none: { tone: 'muted', label: 'No access (no matching grant)', icon: CircleHelpIcon },
};

/** "Denied by group:contractors deny on github__delete_branch" */
export function explainReason(r: EffectiveReason): string {
  const target = r.target.type === 'server' ? `server ${r.target.name}` : r.target.name;
  return `${r.effect === 'deny' ? 'Denied' : 'Allowed'} by ${r.subject.type}:${r.subject.name} ${r.effect} on ${target}`;
}

/**
 * Check access (§5.2, A13): pick a user or agent and a server/tool → decision plus the chain of
 * grants that produced it. Deny always wins, so deny reasons are listed first.
 */
export function CheckAccessSheet({ initial }: { initial?: { type: 'user' | 'agent'; id: string } | undefined }) {
  const [open, setOpen] = useState(!!initial);
  const [type, setType] = useState<'user' | 'agent'>(initial?.type ?? 'user');
  const [subject, setSubject] = useState<PickerOption | null>(initial ? { id: initial.id, name: initial.id.slice(0, 8) } : null);
  const [server, setServer] = useState<PickerOption | null>(null);
  const [tool, setTool] = useState<PickerOption | null>(null);
  const q = useQuery({
    ...effectiveAccessQuery({ subjectType: type, subjectId: subject?.id ?? '', ...(server ? { serverId: server.id } : {}), ...(tool ? { toolId: tool.id } : {}) }),
    enabled: open && !!subject && !!server,
  });
  const d = q.data ? DECISION[q.data.decision] : null;
  const reasons = q.data ? [...q.data.reasons].sort((a, b) => (a.effect === b.effect ? 0 : a.effect === 'deny' ? -1 : 1)) : [];
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button variant="outline" />}>
        <SearchCheckIcon /> Check access
      </SheetTrigger>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Check access</SheetTitle>
          <SheetDescription>Explain why a user or agent can or can't call a tool. Deny always wins.</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-3 px-4">
          <div className="flex flex-wrap items-center gap-2">
            <Segmented<'user' | 'agent'>
              label="Subject type"
              size="sm"
              value={type}
              onChange={(t) => {
                setType(t);
                setSubject(null);
              }}
              options={[
                { value: 'user', label: 'User' },
                { value: 'agent', label: 'Agent' },
              ]}
            />
            <EntityPicker label={type === 'user' ? 'User' : 'Agent'} value={subject} onChange={setSubject} search={type === 'user' ? pickerSearch.users : pickerSearch.agents} queryKey={[`${type}s`]} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <EntityPicker label="Server" value={server} onChange={(s) => { setServer(s); setTool(null); }} search={pickerSearch.servers} queryKey={['servers']} />
            <EntityPicker label="Tool" placeholder="Any tool" value={tool} disabled={!server} onChange={setTool} search={pickerSearch.tools(server?.id)} queryKey={['tools', server?.id ?? 'none']} />
          </div>
          {!subject || !server ? <p className="text-[13px] text-muted-foreground">Pick a subject and a server.</p> : null}
          {q.isLoading && subject && server ? <Skeleton className="h-24 w-full" /> : null}
          {q.error ? <ErrorState error={q.error} /> : null}
          {q.data && d ? (
            <section aria-label="Decision" className="flex flex-col gap-3">
              <Pill tone={d.tone} icon={d.icon} className="h-7 px-3 text-sm">
                {d.label}
              </Pill>
              {reasons.length ? (
                <ol className="flex flex-col gap-1.5 text-[13.5px]" aria-label="Reasons">
                  {reasons.map((r) => (
                    <li key={r.grantId} className="flex items-start gap-2">
                      {r.effect === 'deny' ? <BanIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden="true" /> : <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden="true" />}
                      {explainReason(r)}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-[13px] text-muted-foreground">No grant matches. Nothing is allowed until a grant exists.</p>
              )}
              {q.data.perTool?.length ? (
                <table className="w-full text-[13px]" aria-label="Per-tool decisions">
                  <tbody>
                    {q.data.perTool.map((t) => (
                      <tr key={t.toolId} className="border-b last:border-0">
                        <td className="py-1.5 font-mono text-[12.5px]">{t.qualifiedName}</td>
                        <td className="py-1.5">
                          <Pill tone={DECISION[t.decision].tone} icon={DECISION[t.decision].icon}>
                            {t.decision}
                          </Pill>
                        </td>
                        <td className="py-1.5 text-muted-foreground">{t.via?.map(describeVia).join(', ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </section>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
