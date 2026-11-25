import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as z from 'zod';
import { LibraryBigIcon } from 'lucide-react';
import type { LibraryServerDraft } from '@neurouter/shared';
import { AreaError, guard } from '@/app/route-guards';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/layout/page-header';
import { Page } from '@/components/layout/section';
import { GradeBadge, TrustBadge } from '@/features/library/grade';
import { libraryEntryQuery } from '@/features/library/queries';
import { defaultAuth, ServerForm, type ServerFormValues } from '@/features/servers/server-form';
import { serverKeys } from '@/features/servers/queries';
import { useFollowInitialSync } from '@/features/servers/use-sync';
import { useMe } from '@/hooks/use-me';
import { notifySuccess } from '@/lib/notify';

export const Route = createFileRoute('/_app/admin/servers/new')({
  staticData: { crumbs: ['Administration', 'Servers', 'Register'] },
  validateSearch: z.object({ fromLibrary: z.string().max(128).optional().catch(undefined) }),
  beforeLoad: guard(['servers:create']),
  errorComponent: AreaError,
  component: NewServerPage,
});

/** Library draft → form values. Secrets stay empty; library imports always start untrusted (strict pinning is the default). */
function fromDraft(d: LibraryServerDraft): Partial<ServerFormValues> {
  return {
    name: d.name,
    slug: d.slug,
    description: d.description,
    tags: d.tags.join(', '),
    url: d.url,
    transport: d.transport,
    trusted: false,
    auth: d.auth.type === 'shared_header' ? { type: 'shared_header', headerName: d.auth.headerName, headerValue: '' } : defaultAuth(d.auth.type),
  };
}

function NewServerPage() {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { fromLibrary } = Route.useSearch();
  const followInitialSync = useFollowInitialSync();
  const entry = useQuery({ ...libraryEntryQuery(fromLibrary ?? ''), enabled: !!fromLibrary });
  const draft = entry.data?.draft ?? null;
  return (
    <Page width="form">
      <PageHeader title="Register a server" description="Connect an upstream MCP server. Its tools are discovered and stay disabled until reviewed." />
      {fromLibrary && entry.isLoading ? <Skeleton className="h-96 w-full" /> : null}
      {entry.data && draft ? (
        <div className="-mt-2 flex flex-col gap-2 rounded-xl border bg-card p-4 text-[13.5px]">
          <div className="flex items-center gap-3">
            <GradeBadge grade={entry.data.quality.grade} confidence={entry.data.quality.confidence} />
            <div className="flex min-w-0 flex-col">
              <span className="inline-flex items-center gap-1.5 font-medium">
                <LibraryBigIcon className="size-4 text-muted-foreground" aria-hidden="true" /> From the library
              </span>
              <span className="font-mono text-xs break-all text-muted-foreground">
                {entry.data.name} @ {entry.data.version}
              </span>
            </div>
            <span className="ml-auto">
              <TrustBadge trust={entry.data.quality.trust} reason={entry.data.quality.trustReason} />
            </span>
          </div>
          <p className="text-muted-foreground">Pre-filled from the registry. Choose the owner and enter any credentials; the server starts untrusted and every tool waits for review.</p>
          {draft.notes.length ? (
            <ul className="flex list-disc flex-col gap-1 pl-5 text-warning">
              {draft.notes.map((n) => (
                <li key={n}>
                  <span className="text-foreground">{n}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {!fromLibrary || entry.data || entry.error ? (
        <ServerForm
          key={entry.data?.id ?? 'blank'}
          me={{ id: me.user.id, name: me.user.name }}
          {...(draft && entry.data ? { initial: fromDraft(draft), libraryEntryId: entry.data.id } : {})}
          onRegistered={(id, jobId) => {
            void qc.invalidateQueries({ queryKey: serverKeys.all });
            void qc.invalidateQueries({ queryKey: ['library'] });
            void followInitialSync(id, jobId);
            notifySuccess('Server registered', 'Initial sync started. New tools stay disabled until reviewed.');
            void navigate({ to: '/admin/servers/$serverId', params: { serverId: id }, search: { tab: 'tools' } });
          }}
        />
      ) : null}
    </Page>
  );
}
