import { useMemo, useState } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { BanIcon, CheckIcon, DotIcon, SearchIcon } from 'lucide-react';
import { api, type EffectiveAccess, type SubjectType } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { EntityPicker, type PickerOption } from '@/components/filters/entity-picker';
import { Segmented } from '@/components/filters/segmented';
import { Pill } from '@/components/status/status';
import { apiFetch } from '@/lib/api-client';
import { plural } from '@/lib/format';
import { notifyError, notifySuccess } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { pickerSearch } from '../pickers';
import {
  baseValue, batchBody, cellKey, filterColumns, indexGrants, inheritedFor, matrixSubjects, stage, stagedSummary, subjectKey,
  type CellValue, type MatrixColumn, type MatrixSubject,
} from './matrix';
import { effectiveAccessQuery, grantKeys, grantsListQuery } from './queries';
import { SubjectCell } from './subject';

const SEGMENTS: { value: CellValue; label: string; icon: typeof CheckIcon; on: string }[] = [
  { value: 'inherit', label: 'Inherit', icon: DotIcon, on: 'bg-background text-foreground shadow-sm dark:bg-input/40' },
  { value: 'allow', label: 'Allow', icon: CheckIcon, on: 'bg-success text-success-foreground' },
  { value: 'deny', label: 'Deny', icon: BanIcon, on: 'bg-destructive text-white dark:text-background' },
];

function Cell({ label, value, staged, readOnly, inherited, onPick }: { label: string; value: CellValue; staged: boolean; readOnly: boolean; inherited: { effect: 'allow' | 'deny'; source: string } | null; onPick: (v: CellValue) => void }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div role="radiogroup" aria-label={label} className={cn('inline-flex rounded-md bg-muted p-0.5', staged && 'ring-2 ring-warning')}>
        {SEGMENTS.map((s) => {
          const on = s.value === value;
          return (
            <button
              key={s.value}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={s.label}
              disabled={readOnly}
              onClick={() => onPick(s.value)}
              className={cn('inline-flex h-[22px] w-[26px] items-center justify-center rounded text-muted-foreground transition-colors disabled:cursor-not-allowed', on ? s.on : 'hover:text-foreground')}
            >
              <s.icon className="size-3.5" aria-hidden="true" />
            </button>
          );
        })}
      </div>
      {value === 'inherit' && inherited ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                tabIndex={0}
                aria-label={`Inherited ${inherited.effect} ${inherited.source}`}
                className="inline-flex h-4 items-center gap-0.5 rounded-full bg-muted px-1.5 text-[10.5px] text-muted-foreground"
              />
            }
          >
            {inherited.effect === 'allow' ? <CheckIcon className="size-2.5" aria-hidden="true" /> : <BanIcon className="size-2.5" aria-hidden="true" />}
            inherited
          </TooltipTrigger>
          <TooltipContent>
            Inherited {inherited.effect}: {inherited.source}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}

/**
 * Access matrix (§5.2, W4): subjects × (server + tools) on one server; tri-state cells staged
 * locally, inherited access as a muted badge, column search, and one atomic batch save.
 */
export function AccessMatrix({ server, onServer, readOnly }: { server: PickerOption | null; onServer: (s: PickerOption | null) => void; readOnly: boolean }) {
  const qc = useQueryClient();
  const grants = useQuery({ ...grantsListQuery({ serverId: server?.id, limit: 200 }), enabled: !!server });
  const tools = useQuery({
    queryKey: ['tools', 'list', { serverId: server?.id, matrix: true }],
    queryFn: ({ signal }) => apiFetch(api.tools.list, { query: { serverId: [server!.id], limit: 200 }, signal }),
    enabled: !!server,
  });
  const [added, setAdded] = useState<MatrixSubject[]>([]);
  const [addType, setAddType] = useState<SubjectType>('group');
  const [staged, setStaged] = useState<Record<string, CellValue>>({});
  const [colQuery, setColQuery] = useState('');
  const [reviewing, setReviewing] = useState(false);

  const index = useMemo(() => indexGrants(grants.data?.items ?? []), [grants.data]);
  const subjects = useMemo(() => matrixSubjects(grants.data?.items ?? [], added), [grants.data, added]);
  const columns: MatrixColumn[] = useMemo(
    () => [
      ...(server ? [{ targetType: 'server' as const, id: server.id, label: 'Server (all tools)' }] : []),
      ...(tools.data?.items ?? []).map((t) => ({ targetType: 'tool' as const, id: t.id, label: t.name, requiresApproval: t.requiresApproval })),
    ],
    [server, tools.data],
  );
  const visible = filterColumns(columns, colQuery);

  // effective access (with `via`) for user/agent rows, for the inherited badges
  const effectiveRows = subjects.filter((s) => s.type !== 'group');
  const effective = useQueries({
    queries: effectiveRows.map((s) => ({ ...effectiveAccessQuery({ subjectType: s.type as 'user' | 'agent', subjectId: s.id, serverId: server?.id }), enabled: !!server })),
  });
  const effectiveBySubject = new Map<string, EffectiveAccess | undefined>(effectiveRows.map((s, i) => [subjectKey(s), effective[i]?.data]));

  const names = new Map<string, string>([
    ...subjects.map((s) => [subjectKey(s), `${s.type}:${s.name}`] as const),
    ...columns.map((c) => [`${c.targetType}:${c.id}`, c.targetType === 'server' ? `${server?.name ?? 'server'} (all)` : c.label] as const),
  ]);

  const save = useMutation({
    mutationFn: () => apiFetch(api.grants.batch, { body: batchBody(staged, index) }),
    onSuccess: (r) => {
      notifySuccess('Access saved', `${r.created} created · ${r.updated} updated · ${r.deleted} removed`);
      setStaged({});
      setReviewing(false);
      void qc.invalidateQueries({ queryKey: grantKeys.all });
    },
    onError: (err) => notifyError(err, 'Could not save access changes'),
  });

  const count = Object.keys(staged).length;

  return (
    <div className="relative flex flex-col gap-3 pb-24">
      <div className="flex flex-wrap items-center gap-2">
        <EntityPicker
          label="Server"
          value={server}
          allowClear={false}
          onChange={(s) => {
            setStaged({});
            setAdded([]);
            onServer(s);
          }}
          search={pickerSearch.servers}
          queryKey={['servers']}
          icon={<span className="text-muted-foreground">Server:</span>}
        />
        {!readOnly && server ? (
          <span className="inline-flex items-center gap-1">
            <Segmented<SubjectType>
              label="New row type"
              size="sm"
              value={addType}
              onChange={setAddType}
              options={[
                { value: 'group', label: 'Group' },
                { value: 'user', label: 'User' },
                { value: 'agent', label: 'Agent' },
              ]}
            />
            <EntityPicker
              label="Add subject"
              placeholder="Add subject…"
              value={null}
              onChange={(o) => o && setAdded((a) => [...a, { type: addType, id: o.id, name: o.name }])}
              search={addType === 'user' ? pickerSearch.users : addType === 'agent' ? pickerSearch.agents : pickerSearch.groups}
              queryKey={[`${addType}s`]}
            />
          </span>
        ) : null}
        <label className="relative flex items-center">
          <span className="sr-only">Filter tool columns</span>
          <SearchIcon aria-hidden="true" className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground" />
          <Input type="search" className="h-9 w-52 pl-8" placeholder="Filter tools…" value={colQuery} onChange={(e) => setColQuery(e.target.value)} />
        </label>
        <div className="flex-1" />
        <div className="flex items-center gap-3 text-[12.5px] text-muted-foreground" aria-hidden="true">
          <span className="inline-flex items-center gap-1"><DotIcon className="size-3.5" />Inherit</span>
          <span className="inline-flex items-center gap-1"><CheckIcon className="size-3.5 text-success" />Allow</span>
          <span className="inline-flex items-center gap-1"><BanIcon className="size-3.5 text-destructive" />Deny</span>
          <span className="inline-flex items-center gap-1.5"><span className="size-3.5 rounded ring-2 ring-warning" />Staged</span>
        </div>
      </div>

      {!server ? <EmptyState title="Pick a server" description="The matrix shows every subject with a grant on one server, one column per tool." /> : null}
      {server && (grants.error || tools.error) ? <ErrorState error={grants.error ?? tools.error} /> : null}
      {server && (grants.isLoading || tools.isLoading) ? <Skeleton className="h-64 w-full" /> : null}

      {server && grants.data && tools.data ? (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <table className="border-separate border-spacing-0 text-sm" aria-label={`Access matrix for ${server.name}`}>
            <thead>
              <tr>
                <th scope="col" className="sticky left-0 z-10 min-w-56 border-b bg-card px-3 py-2 text-left align-bottom text-[12.5px] font-medium text-muted-foreground">
                  Subject
                </th>
                {visible.map((c) => (
                  <th key={`${c.targetType}:${c.id}`} scope="col" className="min-w-24 border-b px-2 py-2 align-bottom text-[11.5px] font-medium">
                    <div className="flex flex-col items-center gap-0.5">
                      <span className={cn('max-w-24 leading-tight break-all', c.targetType === 'tool' && 'font-mono')}>{c.label}</span>
                      {c.requiresApproval ? <Pill tone="warn" className="h-[18px] px-1.5 text-[10.5px]">approval</Pill> : null}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {subjects.length === 0 ? (
                <tr>
                  <td colSpan={visible.length + 1} className="p-4 text-muted-foreground">
                    No grants on {server.name} yet. Add a subject to start.
                  </td>
                </tr>
              ) : null}
              {subjects.map((s) => (
                <tr key={subjectKey(s)}>
                  <th scope="row" className="sticky left-0 z-10 border-b bg-card px-3 py-2 text-left font-normal">
                    <SubjectCell type={s.type} name={s.name} />
                  </th>
                  {visible.map((c) => {
                    const key = cellKey(s, c);
                    const original = baseValue(index, key);
                    const value = staged[key] ?? original;
                    return (
                      <td key={key} className="border-b px-2 py-2 text-center">
                        <Cell
                          label={`${s.type}:${s.name} on ${c.targetType === 'server' ? `all ${server.name} tools` : `${server.name}__${c.label}`}`}
                          value={value}
                          staged={key in staged}
                          readOnly={readOnly}
                          inherited={inheritedFor(s, c, index, effectiveBySubject.get(subjectKey(s)), server, staged)}
                          onPick={(v) => setStaged((st) => stage(st, key, v, original))}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {server ? (
        <p className="text-[12.5px] text-muted-foreground">
          Effective access also depends on group membership and agent scope: use Check access to explain a decision.
        </p>
      ) : null}

      {count > 0 ? (
        <div role="region" aria-label="Staged changes" className="sticky bottom-4 z-20 flex flex-wrap items-center gap-3 rounded-xl border bg-card px-4 py-3 shadow-lg">
          <Pill tone="warn">{plural(count, 'change')} staged</Pill>
          <span className="min-w-52 flex-1 text-[13.5px]">{stagedSummary(staged, names)}</span>
          <Button variant="ghost" size="sm" onClick={() => setStaged({})}>
            Discard
          </Button>
          <Button size="sm" onClick={() => setReviewing(true)}>
            Review &amp; save…
          </Button>
        </div>
      ) : null}

      <Sheet open={reviewing} onOpenChange={setReviewing}>
        <SheetContent className="w-full sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Review access changes</SheetTitle>
            <SheetDescription>Saved in one atomic batch. If any change is rejected, nothing is applied.</SheetDescription>
          </SheetHeader>
          <ul className="flex flex-col gap-2 overflow-y-auto px-4" aria-label="Changes to save">
            {Object.entries(staged).map(([key, v]) => {
              const [subj, target] = key.split('|') as [string, string];
              const before = baseValue(index, key);
              return (
                <li key={key} className="flex flex-col gap-0.5 rounded-lg border p-2.5 text-[13px]">
                  <span className="font-medium">{names.get(subj) ?? subj}</span>
                  <span className="text-muted-foreground">
                    {names.get(target) ?? target}: {before} → <b className={v === 'deny' ? 'text-destructive' : v === 'allow' ? 'text-success' : ''}>{v === 'inherit' ? 'inherit (remove grant)' : v}</b>
                  </span>
                </li>
              );
            })}
          </ul>
          <SheetFooter>
            <Button disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? <Spinner /> : null}
              Save {plural(count, 'change')}
            </Button>
            <Button variant="outline" onClick={() => setReviewing(false)}>
              Back
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}
