import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import * as z from 'zod';
import { can } from '@neurouter/shared';
import { AreaError, guard } from '@/app/route-guards';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ErrorState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { Page } from '@/components/layout/section';
import { Pill, ReviewStateBadge } from '@/components/status/status';
import { settingsQuery } from '@/features/settings/queries';
import { DefinitionPanel } from '@/features/tools/definition-panel';
import { PolicyPanel } from '@/features/tools/policy-panel';
import { definitionDiffQuery, toolQuery } from '@/features/tools/queries';
import { ReviewPanel } from '@/features/tools/review-panel';
import { useMe } from '@/hooks/use-me';

const TABS = ['definition', 'review', 'policy'] as const;
type Tab = (typeof TABS)[number];

export const Route = createFileRoute('/_app/admin/tools/$toolId')({
  staticData: { crumbs: ['Administration', 'Tools'], readOnly: { read: 'tools:read', write: 'tools:write' } },
  validateSearch: z.object({ tab: z.enum(TABS).optional().catch(undefined) }),
  beforeLoad: guard(['tools:read']),
  loaderDeps: ({ search }) => ({ tab: search.tab }),
  // Start the tool and (when opening on Review) its definition diff in parallel instead of
  // fetching the diff only after the tool has rendered. Errors surface in the components.
  loader: ({ context, params, deps }) => {
    void context.queryClient.prefetchQuery(toolQuery(params.toolId));
    if (deps.tab === 'review') void context.queryClient.prefetchQuery(definitionDiffQuery(params.toolId));
  },
  errorComponent: AreaError,
  component: ToolDetailPage,
});

function ToolDetailPage() {
  const { toolId } = Route.useParams();
  const { tab } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const me = useMe();
  const q = useQuery(toolQuery(toolId));
  const settings = useQuery({ ...settingsQuery(), enabled: can(me, 'settings:read') });
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const t = q.data;
  if (!t) return <Skeleton className="h-96 w-full" />;
  const pending = t.reviewState === 'pending_review' || t.hasPendingChange;
  // The Review tab only exists while something is pending: after approving from ?tab=review,
  // fall back to Definition instead of selecting a tab that is no longer rendered (blank page).
  const active: Tab = tab === 'review' && !pending ? 'definition' : (tab ?? (pending ? 'review' : 'definition'));
  return (
    <Page>
      <PageHeader
        title={t.qualifiedName}
        description={
          <>
            Server{' '}
            <Link to="/admin/servers/$serverId" params={{ serverId: t.server.id }} className="font-medium text-foreground underline-offset-4 hover:underline">
              {t.server.name}
            </Link>{' '}
            · {t.annotationsTrusted ? 'trusted annotations' : 'untrusted annotations'}
            {t.title ? ` · ${t.title}` : ''}
          </>
        }
      />
      <div className="-mt-3 flex flex-wrap gap-2">
        <ReviewStateBadge state={t.reviewState} />
        {!t.enabled ? <Pill tone="muted">{pending ? 'Disabled until reviewed' : 'Disabled'}</Pill> : <Pill tone="ok">Enabled</Pill>}
        {t.requiresApproval ? <Pill tone="warn">Requires approval</Pill> : null}
      </div>
      <Tabs value={active} onValueChange={(v) => void navigate({ search: { tab: v as Tab }, replace: true })}>
        <TabsList aria-label="Tool sections">
          <TabsTrigger value="definition">Definition</TabsTrigger>
          {pending ? (
            <TabsTrigger value="review">
              Review <span aria-hidden="true" className="size-1.5 rounded-full bg-warning" />
            </TabsTrigger>
          ) : null}
          <TabsTrigger value="policy">Policy</TabsTrigger>
        </TabsList>
        <TabsContent value="definition" className="pt-3">
          <DefinitionPanel tool={t} showHistory={can(me, 'tools:read', { serverId: t.server.id })} />
        </TabsContent>
        {pending ? (
          <TabsContent value="review" className="pt-3">
            <ReviewPanel tool={t} canWrite={can(me, 'tools:write', { serverId: t.server.id })} />
          </TabsContent>
        ) : null}
        <TabsContent value="policy" className="pt-3">
          <PolicyPanel tool={t} defaults={settings.data?.rateLimits.tool} />
        </TabsContent>
      </Tabs>
    </Page>
  );
}
