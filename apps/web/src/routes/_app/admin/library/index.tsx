import { useEffect, useState } from 'react';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as z from 'zod';
import { LibraryBigIcon, RefreshCwIcon, SettingsIcon } from 'lucide-react';
import { api, type LibraryEntryRow, type LibraryStatus } from '@neurouter/shared';
import { AreaError, guard } from '@/app/route-guards';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { CursorPager } from '@/components/data-table/cursor-pager';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { SearchInput } from '@/components/filters/search-input';
import { Segmented } from '@/components/filters/segmented';
import { PageHeader } from '@/components/layout/page-header';
import { Page, Toolbar } from '@/components/layout/section';
import { Pill } from '@/components/status/status';
import { FlagPill, GradeBadge, TrustBadge } from '@/features/library/grade';
import { LibrarySettingsDialog } from '@/features/library/settings-dialog';
import { libraryKeys, libraryListQuery, libraryStatusQuery } from '@/features/library/queries';
import { useCursorStack } from '@/hooks/use-cursor-stack';
import { apiFetch } from '@/lib/api-client';
import { formatRelative } from '@/lib/format';
import { notifyError, notifySuccess } from '@/lib/notify';

const GRADES = ['any', 'B', 'C'] as const;
const TRUSTS = ['any', 'verified', 'known'] as const;

export const Route = createFileRoute('/_app/admin/library/')({
  staticData: { crumbs: ['Administration', 'Library'] },
  validateSearch: z.object({
    q: z.string().max(200).optional().catch(undefined),
    grade: z.enum(GRADES).optional().catch(undefined),
    trust: z.enum(TRUSTS).optional().catch(undefined),
    local: z.boolean().optional().catch(undefined),
    hidden: z.boolean().optional().catch(undefined),
  }),
  beforeLoad: guard(['servers:create']),
  errorComponent: AreaError,
  component: LibraryPage,
});

function SyncLine({ st }: { st: LibraryStatus }) {
  if (st.sync.running) return <span className="inline-flex items-center gap-1.5"><Spinner /> Syncing{st.sync.mode === 'full' ? ` (full crawl, page ${st.sync.pages})` : ''}…</span>;
  if (st.sync.lastError) return <span className="text-destructive">Last sync failed: {st.sync.lastError}</span>;
  return <span>{st.sync.lastSuccessAt ? `Synced ${formatRelative(st.sync.lastSuccessAt)}` : 'Not synced yet'}</span>;
}

function EntryItem({ e }: { e: LibraryEntryRow }) {
  return (
    <li className="flex gap-3.5 p-4 hover:bg-muted/40">
      <GradeBadge grade={e.grade} confidence={e.confidence} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <Link to="/admin/library/$entryId" params={{ entryId: e.id }} className="font-medium underline-offset-4 hover:underline">
            {e.title ?? e.name.split('/').pop()}
          </Link>
          <span className="font-mono text-xs break-all text-muted-foreground">{e.name}</span>
        </div>
        {e.description ? <p className="line-clamp-2 text-[13.5px] text-muted-foreground">{e.description}</p> : null}
        <div className="flex flex-wrap gap-1.5">
          <TrustBadge trust={e.trust} />
          {e.hasRemote ? <Pill tone="outline">{e.transport === 'sse' ? 'Remote · SSE' : 'Remote'}</Pill> : <Pill tone="muted">Local only (stdio)</Pill>}
          {e.status === 'deprecated' ? <Pill tone="warn">Deprecated</Pill> : null}
          {e.inGateway ? <Pill tone="info">In gateway: {e.inGateway.name}</Pill> : null}
          {e.hidden ? <Pill tone="muted">Hidden</Pill> : null}
          {/* (a domain mismatch is already the publisher badge) */}
          {e.topFlag && e.topFlag.severity !== 'info' && e.topFlag.code !== 'domain_mismatch' ? <FlagPill flag={e.topFlag} /> : null}
        </div>
      </div>
    </li>
  );
}

function LibraryPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const qc = useQueryClient();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const status = useQuery({ ...libraryStatusQuery(), refetchInterval: (q) => (q.state.data?.sync.running ? 3000 : false) });
  const filters = {
    q: search.q,
    ...(search.grade && search.grade !== 'any' ? { minGrade: search.grade } : {}),
    ...(search.trust && search.trust !== 'any' ? { trust: search.trust } : {}),
    remoteOnly: !search.local,
    includeHidden: !!search.hidden,
  };
  const pager = useCursorStack(JSON.stringify(filters));
  const list = useQuery({ ...libraryListQuery({ ...filters, cursor: pager.cursor ?? undefined, limit: 30 }), placeholderData: keepPreviousData, enabled: !!status.data && status.data.counts.total > 0 });
  const sync = useMutation({
    mutationFn: () => apiFetch(api.library.sync, {}),
    onSuccess: (r) => {
      notifySuccess(r.started ? 'Sync started' : 'A sync is already running');
      void qc.invalidateQueries({ queryKey: libraryKeys.status() });
    },
    onError: (err) => notifyError(err, 'Could not start the sync'),
  });
  // a sync that just finished changes the results
  const lastSync = status.data?.sync.lastSuccessAt;
  useEffect(() => {
    if (lastSync) void qc.invalidateQueries({ queryKey: [...libraryKeys.all, 'list'] });
  }, [lastSync, qc]);
  const set = (patch: Partial<typeof search>) => void navigate({ search: (prev) => ({ ...prev, ...patch }) });

  if (status.error) return <Page><ErrorState error={status.error} onRetry={() => void status.refetch()} /></Page>;
  const st = status.data;
  return (
    <Page>
      <PageHeader
        title="Library"
        description="MCP servers from the registry, graded by observable signals. Add a good one to the gateway in a few clicks."
        actions={
          st ? (
            <>
              <Button variant="outline" onClick={() => setSettingsOpen(true)}>
                <SettingsIcon /> Settings
              </Button>
              {st.enabled ? (
                <Button variant="outline" disabled={sync.isPending || st.sync.running} onClick={() => sync.mutate()}>
                  {sync.isPending || st.sync.running ? <Spinner /> : <RefreshCwIcon />} Sync now
                </Button>
              ) : null}
            </>
          ) : undefined
        }
      />
      {st ? <LibrarySettingsDialog key={String(settingsOpen)} status={st} open={settingsOpen} onOpenChange={setSettingsOpen} /> : null}
      {!st ? (
        <Skeleton className="h-40 w-full" />
      ) : !st.enabled && st.counts.total === 0 ? (
        <EmptyState
          icon={LibraryBigIcon}
          title="Registry sync is off"
          description={
            <>
              Turn it on to copy the public MCP registry ({st.registryUrl.replace(/^https:\/\//, '')}) into this gateway and search it. The gateway then makes hourly outbound requests to that URL.
              You can point it at an internal mirror instead.
            </>
          }
          action={<Button onClick={() => setSettingsOpen(true)}>Enable registry sync…</Button>}
        />
      ) : (
        <>
          <div className="-mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
            <SyncLine st={st} />
            <span>{st.counts.total.toLocaleString('en-GB')} servers · {st.counts.remote.toLocaleString('en-GB')} with a remote endpoint · {st.counts.checked.toLocaleString('en-GB')} checked</span>
          </div>
          <Toolbar className="flex-wrap">
            <SearchInput label="Search the library" placeholder="Search by name, purpose, publisher…" value={search.q} onChange={(v) => set({ q: v })} />
            <Segmented label="Minimum grade" size="sm" value={search.grade ?? 'any'} onChange={(v) => set({ grade: v === 'any' ? undefined : v })} options={[{ value: 'any', label: 'Any grade' }, { value: 'B', label: 'B or better' }, { value: 'C', label: 'C or better' }]} />
            <Segmented label="Publisher" size="sm" value={search.trust ?? 'any'} onChange={(v) => set({ trust: v === 'any' ? undefined : v })} options={[{ value: 'any', label: 'Any publisher' }, { value: 'known', label: 'Known' }, { value: 'verified', label: 'Verified' }]} />
            <label className="flex items-center gap-2 text-[13px]">
              <Switch checked={!!search.local} onCheckedChange={(v) => set({ local: v || undefined })} /> Local-only servers
            </label>
            <label className="flex items-center gap-2 text-[13px]">
              <Switch checked={!!search.hidden} onCheckedChange={(v) => set({ hidden: v || undefined })} /> Hidden
            </label>
          </Toolbar>
          {list.error ? (
            <ErrorState error={list.error} onRetry={() => void list.refetch()} />
          ) : list.isLoading || (st.counts.total > 0 && !list.data) ? (
            <Skeleton className="h-64 w-full" />
          ) : !list.data?.items.length ? (
            <EmptyState icon={LibraryBigIcon} title={st.counts.total === 0 ? 'The library is empty' : 'No servers match'} description={st.counts.total === 0 ? 'The first sync copies the registry; it takes a few minutes.' : 'Try fewer words or loosen the filters.'} />
          ) : (
            <ul className="flex flex-col divide-y rounded-xl border bg-card" aria-label="Library servers">
              {list.data.items.map((e) => (
                <EntryItem key={e.id} e={e} />
              ))}
            </ul>
          )}
          <CursorPager page={pager.page} hasPrev={pager.hasPrev} hasNext={!!list.data?.nextCursor} onPrev={pager.prev} onNext={() => pager.next(list.data?.nextCursor)} />
          <p className="text-xs text-muted-foreground">{st.attribution} Grades are computed by rules from what the gateway can observe; open a server to see why it got its grade.</p>
        </>
      )}
    </Page>
  );
}

