import { useMemo, useState } from 'react';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as z from 'zod';
import { FilterIcon, LayoutGridIcon, PlugIcon, SearchXIcon, TagIcon } from 'lucide-react';
import { api, can, type AccessRequest, type CatalogTool } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { SearchInput } from '@/components/filters/search-input';
import { Segmented } from '@/components/filters/segmented';
import { PageHeader } from '@/components/layout/page-header';
import { Page } from '@/components/layout/section';
import { Pill } from '@/components/status/status';
import { myRequestsQuery, requestKeys } from '@/features/access-requests/queries';
import { RequestAccessDialog, type RequestTarget } from '@/features/access-requests/request-access-dialog';
import { authKeys } from '@/features/auth/queries';
import { ToolAccessBadge } from '@/features/catalog/access';
import { catalogKeys, catalogServersQuery, catalogTagsQuery, catalogToolsQuery } from '@/features/catalog/queries';
import { ServerCard } from '@/features/catalog/server-card';
import { authorizeUrl } from '@/features/connections/connections';
import { useIsMobile } from '@/hooks/use-mobile';
import { useMe } from '@/hooks/use-me';
import { apiFetch } from '@/lib/api-client';
import { browserNavigation } from '@/lib/navigation';
import { formatNumber, plural } from '@/lib/format';
import { notifyError, notifySuccess } from '@/lib/notify';

const search = z.object({
  q: z.string().max(200).optional().catch(undefined),
  view: z.enum(['servers', 'tools']).optional().catch(undefined),
  tag: z.preprocess((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]), z.array(z.string().max(50)).optional()).catch(undefined),
  access: z.enum(['all', 'granted', 'requestable']).optional().catch(undefined),
});
type Search = z.infer<typeof search>;

export const Route = createFileRoute('/_app/catalog/')({
  staticData: { crumbs: ['Portal', 'Catalog'] },
  validateSearch: search,
  component: CatalogPage,
});

/** Number of active filters shown on the mobile "Filters (n)" button. */
export function activeFilterCount(s: Pick<Search, 'tag' | 'access'>): number {
  return (s.tag?.length ?? 0) + (s.access && s.access !== 'all' ? 1 : 0);
}

const ACCESS_ITEMS = [
  { value: 'all', label: 'Access: All' },
  { value: 'granted', label: 'Available to me' },
  { value: 'requestable', label: 'Requestable' },
];

/** Index of my pending requests by target server and tool. */
export function pendingIndex(items: AccessRequest[] | undefined): Map<string, AccessRequest> {
  const m = new Map<string, AccessRequest>();
  for (const r of items ?? []) if (r.status === 'pending') m.set(r.target.type === 'server' ? r.target.server.id : r.target.id, r);
  return m;
}

export function useCancelRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (r: AccessRequest) => apiFetch(api.accessRequests.cancelMine, { params: { id: r.id } }),
    onSuccess: () => {
      notifySuccess('Request cancelled');
      void qc.invalidateQueries({ queryKey: requestKeys.all });
      void qc.invalidateQueries({ queryKey: catalogKeys.all });
      void qc.invalidateQueries({ queryKey: authKeys.badges });
    },
    onError: (err) => notifyError(err, 'Could not cancel the request'),
  });
}

function ToolRowItem({ t, onRequest }: { t: CatalogTool; onRequest: () => void }) {
  return (
    <li className="flex flex-wrap items-center gap-3 border-b px-4 py-3 last:border-0">
      <div className="flex min-w-60 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <Link to="/catalog/$serverId" params={{ serverId: t.server.id }} className="font-mono text-[13px] font-medium underline-offset-4 hover:underline">
            {t.qualifiedName}
          </Link>
          {t.requiresApproval ? <Pill tone="warn">Requires approval</Pill> : null}
        </div>
        <span className="line-clamp-1 text-[13px] text-muted-foreground">{t.description}</span>
      </div>
      <span className="text-[13px] text-muted-foreground">{t.server.name}</span>
      <ToolAccessBadge access={t.access} />
      {t.access === 'none' ? (
        <Button size="xs" variant="outline" onClick={onRequest} aria-label={`Request access to ${t.qualifiedName}`}>
          Request
        </Button>
      ) : null}
    </li>
  );
}

/** Below md the tag and access filters move into a bottom sheet (frontend §8, MobileCatalog.dc.html). */
function FilterSheet({ s, tags, onApply }: { s: Search; tags: { name: string; count: number }[]; onApply: (p: Partial<Search>) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<{ tag: string[]; access: NonNullable<Search['access']> }>({ tag: [], access: 'all' });
  const n = activeFilterCount(s);
  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (o) setDraft({ tag: s.tag ?? [], access: s.access ?? 'all' });
        setOpen(o);
      }}
    >
      <Button variant="outline" size="lg" onClick={() => setOpen(true)} className="shrink-0">
        <FilterIcon /> Filters{n ? ` (${n})` : ''}
      </Button>
      <SheetContent side="bottom" className="max-h-[85svh] rounded-t-xl">
        <SheetHeader>
          <SheetTitle>Filters</SheetTitle>
          <SheetDescription>Narrow the catalog by access and tags.</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-5 overflow-y-auto px-4">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">Access</legend>
            <RadioGroup value={draft.access} onValueChange={(v) => setDraft({ ...draft, access: v as NonNullable<Search['access']> })}>
              {ACCESS_ITEMS.map((i) => (
                <label key={i.value} className="flex items-center gap-2.5 text-sm">
                  <RadioGroupItem value={i.value} />
                  {i.value === 'all' ? 'All servers' : i.label}
                </label>
              ))}
            </RadioGroup>
          </fieldset>
          {tags.length ? (
            <fieldset className="flex flex-col gap-2.5">
              <legend className="mb-2 text-sm font-medium">Tags</legend>
              {tags.map((t) => (
                <label key={t.name} className="flex items-center gap-2.5 text-sm">
                  <Checkbox
                    checked={draft.tag.includes(t.name)}
                    onCheckedChange={(c) => setDraft({ ...draft, tag: c ? [...draft.tag, t.name] : draft.tag.filter((x) => x !== t.name) })}
                  />
                  {t.name}
                  <span className="ml-auto text-xs text-muted-foreground tabular-nums">{t.count}</span>
                </label>
              ))}
            </fieldset>
          ) : null}
        </div>
        <SheetFooter className="grid grid-cols-2 gap-2">
          <Button variant="outline" size="lg" onClick={() => setDraft({ tag: [], access: 'all' })}>
            Reset
          </Button>
          <Button
            size="lg"
            onClick={() => {
              onApply({ tag: draft.tag.length ? draft.tag : undefined, access: draft.access === 'all' ? undefined : draft.access });
              setOpen(false);
            }}
          >
            Show results
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function CatalogPage() {
  const me = useMe();
  const compact = useIsMobile();
  const s = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const set = (p: Partial<Search>) => void navigate({ search: (prev) => ({ ...prev, ...p }) });
  const view = s.view ?? 'servers';
  const servers = useQuery({ ...catalogServersQuery({ q: s.q, tag: s.tag, access: s.access, limit: 200 }), placeholderData: keepPreviousData });
  const tools = useQuery({ ...catalogToolsQuery({ q: s.q, access: s.access, limit: 100 }), enabled: view === 'tools', placeholderData: keepPreviousData });
  const tags = useQuery(catalogTagsQuery());
  const mine = useQuery(myRequestsQuery({ status: 'pending', limit: 200 }));
  const pending = useMemo(() => pendingIndex(mine.data?.items), [mine.data]);
  const cancel = useCancelRequest();
  const [requesting, setRequesting] = useState<RequestTarget | null>(null);
  const totalTools = servers.data?.items.reduce((n, x) => n + x.toolCount, 0) ?? 0;
  const filtered = !!(s.q || s.tag?.length || (s.access && s.access !== 'all'));
  return (
    <Page>
      <PageHeader
        title="Catalog"
        description={compact ? 'Servers and tools you can use, and ones you can request.' : 'Find the MCP servers and tools you can use through the gateway, and request access to the rest.'}
        actions={
          <Button variant="outline" render={<Link to="/connect" />}>
            <PlugIcon /> Connect a client
          </Button>
        }
      />
      {compact ? (
        <div className="flex flex-col gap-3">
          <SearchInput label="Search servers and tools" placeholder="Search servers, tools…" value={s.q} onChange={(q) => set({ q })} className="max-w-none" />
          <div className="flex items-center gap-2">
            <Segmented label="View" className="h-10 w-auto flex-1 [&>button]:flex-1 [&>button]:justify-center" value={view} onChange={(v) => set({ view: v === 'servers' ? undefined : v })} options={[{ value: 'servers', label: 'Servers' }, { value: 'tools', label: 'Tools' }]} />
            <FilterSheet s={s} tags={tags.data?.tags ?? []} onApply={set} />
          </div>
          <span className="text-[12.5px] text-muted-foreground tabular-nums">
            Access: {s.access === 'granted' ? 'Available to me' : s.access === 'requestable' ? 'Requestable' : 'All'}
            {s.tag?.length ? ` · ${s.tag.join(', ')}` : ''}
            {view === 'servers' && servers.data ? ` · ${plural(servers.data.items.length, 'server')}` : view === 'tools' && tools.data ? ` · ${plural(tools.data.items.length, 'tool')}` : ''}
          </span>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput label="Search servers and tools" placeholder="Search servers, tools, descriptions…" value={s.q} onChange={(q) => set({ q })} className="sm:max-w-md" />
          <Segmented label="View" value={view} onChange={(v) => set({ view: v === 'servers' ? undefined : v })} options={[{ value: 'servers', label: 'Servers' }, { value: 'tools', label: 'Tools' }]} />
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
              <TagIcon /> Tags{s.tag?.length ? ` (${s.tag.length})` : ''}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Tags</DropdownMenuLabel>
                {tags.data?.tags.map((t) => (
                  <DropdownMenuCheckboxItem
                    key={t.name}
                    checked={!!s.tag?.includes(t.name)}
                    onCheckedChange={(c) => {
                      const next = c ? [...(s.tag ?? []), t.name] : (s.tag ?? []).filter((x) => x !== t.name);
                      set({ tag: next.length ? next : undefined });
                    }}
                  >
                    {t.name} <span className="ml-auto text-xs text-muted-foreground">{t.count}</span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Select value={s.access ?? 'all'} onValueChange={(v) => set({ access: v === 'all' ? undefined : (v as Search['access']) })} items={ACCESS_ITEMS}>
            <SelectTrigger aria-label="Access" size="sm" className="min-w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACCESS_ITEMS.map((i) => (
                <SelectItem key={i.value} value={i.value}>
                  {i.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {view === 'tools' ? (
            tools.data ? <span className="text-[13px] text-muted-foreground tabular-nums">{plural(tools.data.items.length, 'tool')}</span> : null
          ) : servers.data ? (
            <span className="text-[13px] text-muted-foreground tabular-nums">
              {plural(servers.data.items.length, 'server')} · {plural(totalTools, 'tool')}
            </span>
          ) : null}
        </div>
      )}
      {view === 'servers' ? (
        servers.error ? (
          <ErrorState error={servers.error} onRetry={() => void servers.refetch()} />
        ) : servers.isLoading ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-48" />
            ))}
          </div>
        ) : servers.data?.items.length === 0 ? (
          filtered ? (
            <EmptyState icon={LayoutGridIcon} title={s.q ? `No servers match “${s.q}”` : 'No servers match these filters'} action={<Button variant="outline" onClick={() => set({ q: undefined, tag: undefined, access: undefined })}>Clear filters</Button>} />
          ) : (
            <EmptyState
              icon={LayoutGridIcon}
              title="No servers yet"
              description={can(me, 'servers:create') ? 'Register an upstream MCP server to get started.' : 'Ask your admin to register MCP servers.'}
              action={can(me, 'servers:create') ? <Button render={<Link to="/admin/servers/new" />}>Register a server</Button> : undefined}
            />
          )
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {servers.data?.items.map((x) => (
              <ServerCard
                key={x.id}
                s={x}
                compact={compact}
                pending={pending.get(x.id)}
                onRequest={() => setRequesting({ type: 'server', id: x.id, name: x.name, ownerName: x.owner.name })}
                onCancel={(r) => cancel.mutate(r)}
                onConnect={() => browserNavigation.assign(authorizeUrl(x.id, '/catalog'))}
              />
            ))}
          </div>
        )
      ) : tools.error ? (
        <ErrorState error={tools.error} onRetry={() => void tools.refetch()} />
      ) : tools.isLoading ? (
        <Skeleton className="h-64" />
      ) : tools.data && tools.data.items.length === 0 ? (
        <EmptyState
          icon={SearchXIcon}
          title={s.q ? `No tools match “${s.q}”` : 'No tools'}
          description={
            s.q ? (
              <>
                {tools.data.suggestion ? (
                  <span className="mb-1 block">
                    Did you mean{' '}
                    <button type="button" className="font-medium text-foreground underline underline-offset-4" onClick={() => set({ q: tools.data.suggestion ?? undefined })}>
                      {tools.data.suggestion}
                    </button>
                    ?
                  </span>
                ) : null}
                Search matches tool names, descriptions and parameters by meaning as well as keywords. Try fewer or more general words, or check the servers view.
              </>
            ) : (
              'Tools you can use or request appear here once servers are registered.'
            )
          }
          action={
            s.q || (s.access && s.access !== 'all') ? (
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="outline" onClick={() => set({ view: undefined })}>
                  Search servers instead
                </Button>
                <Button variant="ghost" onClick={() => set({ q: undefined, access: undefined })}>
                  Clear search
                </Button>
              </div>
            ) : undefined
          }
        />
      ) : (
        <div className="flex flex-col gap-2">
          {s.q ? <p className="text-[12.5px] text-muted-foreground">Best matches first</p> : null}
          <ul aria-label="Tools" className="rounded-xl border bg-card">
            {tools.data?.items.map((t) => (
              <ToolRowItem key={t.id} t={t} onRequest={() => setRequesting({ type: 'tool', id: t.id, name: t.qualifiedName })} />
            ))}
          </ul>
          {tools.data?.nextCursor ? <p className="text-[12.5px] text-muted-foreground">Showing the first {formatNumber(tools.data.items.length)} results. Refine your search to narrow them down.</p> : null}
        </div>
      )}
      <RequestAccessDialog target={requesting} onOpenChange={(o) => !o && setRequesting(null)} />
    </Page>
  );
}
