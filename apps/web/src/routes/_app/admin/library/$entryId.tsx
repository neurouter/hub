import { Link, createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EyeIcon, EyeOffIcon, ExternalLinkIcon, PlusIcon, StethoscopeIcon } from 'lucide-react';
import { api, type LibraryEntryDetail } from '@neurouter/shared';
import { AreaError, guard } from '@/app/route-guards';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { ErrorState } from '@/components/feedback/states';
import { JsonViewer } from '@/components/code/json-viewer';
import { PageHeader } from '@/components/layout/page-header';
import { DetailList, Page, Section } from '@/components/layout/section';
import { Pill } from '@/components/status/status';
import { FlagList, GradeBadge, GradeBreakdown, TrustBadge } from '@/features/library/grade';
import { libraryKeys, libraryEntryQuery } from '@/features/library/queries';
import { apiFetch } from '@/lib/api-client';
import { formatDate, formatDuration, formatRelative } from '@/lib/format';
import { notifyError, notifySuccess } from '@/lib/notify';

export const Route = createFileRoute('/_app/admin/library/$entryId')({
  staticData: { crumbs: ['Administration', 'Library', 'Server'] },
  beforeLoad: guard(['servers:create']),
  errorComponent: AreaError,
  component: EntryPage,
});

const DASH = '—';

function ExtLink({ href }: { href: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 break-all underline-offset-4 hover:underline">
      {href.replace(/^https?:\/\//, '')} <ExternalLinkIcon className="size-3 shrink-0" aria-hidden="true" />
    </a>
  );
}

function CheckSection({ e }: { e: LibraryEntryDetail }) {
  const c = e.check;
  if (!c) {
    return (
      <p className="text-[13.5px] text-muted-foreground">
        Not checked yet. A check connects to the endpoint without credentials, lists and lints the tools if the server allows it, and reads the GitHub repository. It raises the grade's confidence.
      </p>
    );
  }
  const conn = c.connection;
  return (
    <div className="flex flex-col gap-4">
      <DetailList
        items={[
          {
            label: 'Connection',
            value: !conn
              ? 'Not attempted (the URL needs variables)'
              : conn.ok
                ? `Connected without credentials${conn.latencyMs !== null ? ` in ${formatDuration(conn.latencyMs)}` : ''}`
                : conn.authRequired
                  ? `Requires sign-in${conn.oauthDiscovery ? '; OAuth discovery works' : '; no OAuth discovery'}`
                  : `Failed${conn.error ? `: ${conn.error}` : ''}`,
          },
          { label: 'Server', value: conn?.serverInfo ? `${conn.serverInfo.name} ${conn.serverInfo.version}` : DASH },
          { label: 'Protocol', value: <span className="font-mono text-[12.5px]">{conn?.protocolVersion ?? DASH}</span> },
          {
            label: 'Repository',
            value: !c.github
              ? DASH
              : c.github.error
                ? `Not read: ${c.github.error}`
                : !c.github.found
                  ? `${c.github.repo} not found`
                  : `${c.github.repo} · ${c.github.stars.toLocaleString('en-GB')} stars · ${c.github.license ?? 'no license'}${c.github.archived ? ' · archived' : ''}${c.github.pushedAt ? ` · last push ${formatRelative(c.github.pushedAt)}` : ''}`,
          },
          { label: 'Checked', value: formatRelative(c.checkedAt) },
        ]}
      />
      {c.tools.length ? (
        <table className="w-full text-[13.5px]">
          <caption className="mb-2 text-left text-xs font-medium text-muted-foreground">Tool definitions ({c.tools.length})</caption>
          <tbody>
            {c.tools.map((t) => (
              <tr key={t.name} className="border-t align-top">
                <td className="py-2 pr-3 font-mono text-[12.5px] break-all">{t.name}</td>
                <td className="py-2 pr-3 tabular-nums">{Math.round(t.score * 100)}</td>
                <td className="py-2 text-xs text-muted-foreground">{t.issues.length ? t.issues.join(' · ') : 'No issues'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

function EntryPage() {
  const { entryId } = Route.useParams();
  const qc = useQueryClient();
  const q = useQuery(libraryEntryQuery(entryId));
  const onDone = (d: LibraryEntryDetail) => {
    qc.setQueryData(libraryKeys.detail(entryId), d);
    void qc.invalidateQueries({ queryKey: [...libraryKeys.all, 'list'] });
    void qc.invalidateQueries({ queryKey: libraryKeys.status() });
  };
  const check = useMutation({
    mutationFn: () => apiFetch(api.library.check, { params: { id: entryId } }),
    onSuccess: (d) => {
      onDone(d);
      notifySuccess(d.quality.grade ? `Checked: grade ${d.quality.grade}` : 'Checked');
    },
    onError: (err) => notifyError(err, 'The check failed'),
  });
  const hide = useMutation({
    mutationFn: (hidden: boolean) => apiFetch(api.library.update, { params: { id: entryId }, body: { hidden } }),
    onSuccess: (d) => {
      onDone(d);
      notifySuccess(d.hidden ? 'Hidden from the library' : 'Shown in the library');
    },
    onError: (err) => notifyError(err, 'Could not update the entry'),
  });

  if (q.error) return <Page><ErrorState error={q.error} onRetry={() => void q.refetch()} /></Page>;
  if (!q.data) return <Page><Skeleton className="h-96 w-full" /></Page>;
  const e = q.data;
  const remote = e.remotes[0];
  return (
    <Page>
      <PageHeader
        title={e.title ?? e.name.split('/').pop()!}
        leading={<GradeBadge grade={e.quality.grade} confidence={e.quality.confidence} size="lg" />}
        description={e.description || undefined}
        actions={
          <>
            <Button variant="outline" disabled={check.isPending} onClick={() => check.mutate()}>
              {check.isPending ? <Spinner /> : <StethoscopeIcon />} {e.check ? 'Check again' : 'Check now'}
            </Button>
            <Button variant="ghost" disabled={hide.isPending} onClick={() => hide.mutate(!e.hidden)}>
              {e.hidden ? <EyeIcon /> : <EyeOffIcon />} {e.hidden ? 'Unhide' : 'Hide'}
            </Button>
            {e.inGateway ? (
              <Button render={<Link to="/admin/servers/$serverId" params={{ serverId: e.inGateway.id }} />}>Open in gateway</Button>
            ) : e.draft ? (
              <Button render={<Link to="/admin/servers/new" search={{ fromLibrary: e.id }} />}>
                <PlusIcon /> Add to gateway
              </Button>
            ) : null}
          </>
        }
      />
      <div className="-mt-3 flex flex-wrap gap-2">
        <span className="font-mono text-xs break-all text-muted-foreground self-center">
          {e.name} @ {e.version}
        </span>
        <TrustBadge trust={e.quality.trust} reason={e.quality.trustReason} />
        {e.status === 'deprecated' ? <Pill tone="warn">Deprecated{e.statusMessage ? `: ${e.statusMessage}` : ''}</Pill> : null}
        {e.inGateway ? <Pill tone="info">In gateway: {e.inGateway.name}</Pill> : null}
        {e.hidden ? <Pill tone="muted">Hidden</Pill> : null}
        {!e.hasRemote ? <Pill tone="muted">Local only (stdio): not supported by this gateway yet</Pill> : null}
      </div>
      {e.quality.flags.length ? <FlagList flags={e.quality.flags} /> : null}
      <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
        <Section title="Grade" description={e.quality.trustReason}>
          <GradeBreakdown quality={e.quality} />
        </Section>
        <div className="flex flex-col gap-5">
          <Section title="Endpoint">
            <DetailList
              items={[
                { label: 'URL', value: remote ? <span className="font-mono text-[12.5px] break-all">{remote.url}</span> : 'None (package only)' },
                { label: 'Transport', value: remote ? (remote.type === 'sse' ? 'SSE (deprecated)' : 'Streamable HTTP') : DASH },
                { label: 'Declared headers', value: remote?.headers.length ? remote.headers.map((h) => `${h.name}${h.required ? ' (required)' : ''}`).join(', ') : 'None' },
                { label: 'Packages', value: e.packages.length ? e.packages.map((p) => `${p.registryType}: ${p.identifier}`).join(', ') : 'None' },
                { label: 'Repository', value: e.repositoryUrl ? <ExtLink href={e.repositoryUrl} /> : DASH },
                { label: 'Website', value: e.websiteUrl ? <ExtLink href={e.websiteUrl} /> : DASH },
                { label: 'Published', value: e.publishedAt ? formatDate(e.publishedAt) : DASH },
                { label: 'Updated', value: formatDate(e.updatedAt) },
              ]}
            />
            {e.draft?.notes.length ? (
              <ul className="mt-3 flex list-disc flex-col gap-1 pl-5 text-xs text-muted-foreground">
                {e.draft.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            ) : null}
          </Section>
          <Section title="Last check">
            <CheckSection e={e} />
          </Section>
        </div>
      </div>
      <Section title="Registry record" description={<a href={e.sourceUrl} target="_blank" rel="noreferrer noopener" className="underline-offset-4 hover:underline">{e.sourceUrl}</a>}>
        <JsonViewer value={e.serverJson} label="server.json" collapseAfter={60} />
      </Section>
    </Page>
  );
}
