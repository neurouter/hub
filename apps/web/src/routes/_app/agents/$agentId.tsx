import { useState } from 'react';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as z from 'zod';
import { api, can } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { ErrorState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { Pill } from '@/components/status/status';
import { AgentFormDialog } from '@/features/agents/agent-form-dialog';
import { AuthorizedApps } from '@/features/agents/authorized-apps';
import { CreateKeyDialog } from '@/features/agents/create-key-dialog';
import { KeysTable } from '@/features/agents/keys-table';
import { agentKeys, agentQuery, agentsListQuery } from '@/features/agents/queries';
import { EffectiveAccess } from '@/features/agents/effective-access';
import { ScopePanel } from '@/features/agents/scope-panel';
import { RecentActivity } from '@/features/audit/recent-activity';
import { useMe } from '@/hooks/use-me';
import { apiFetch } from '@/lib/api-client';
import { formatRelative, plural } from '@/lib/format';
import { notifyError, notifySuccess } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { agentKindLabel } from './index';

const TABS = ['keys', 'scope', 'apps', 'activity'] as const;
type Tab = (typeof TABS)[number];

export const Route = createFileRoute('/_app/agents/$agentId')({
  staticData: { crumbs: ['Portal', 'My agents'] },
  validateSearch: z.object({ tab: z.enum(TABS).optional().catch(undefined) }),
  component: AgentDetailPage,
});

function MyAgentsAside({ activeId, onNew }: { activeId: string; onNew: () => void }) {
  const q = useQuery(agentsListQuery({ owner: 'me', limit: 200 }));
  return (
    <aside aria-label="My agents" className="flex w-full flex-col gap-2 lg:max-w-[280px] lg:min-w-[240px]">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">My agents</h2>
        <Button variant="outline" size="sm" onClick={onNew}>
          New agent
        </Button>
      </div>
      <nav className="flex flex-col gap-0.5 rounded-xl border bg-card p-1">
        {q.isLoading ? <Skeleton className="h-24 w-full" /> : null}
        {q.data?.items.map((a) => (
          <Link
            key={a.id}
            to="/agents/$agentId"
            params={{ agentId: a.id }}
            aria-current={a.id === activeId ? 'page' : undefined}
            className={cn('flex flex-col rounded-lg px-3 py-2 hover:bg-muted', a.id === activeId && 'bg-accent')}
          >
            <span className={cn(a.id === activeId ? 'font-semibold' : 'font-medium')}>{a.name}</span>
            <span className="text-xs text-muted-foreground">
              {a.kind === 'oauth_client' ? 'OAuth' : plural(a.activeKeyCount, 'active key')} · {a.lastUsedAt ? `used ${formatRelative(a.lastUsedAt)}` : 'never used'}
            </span>
          </Link>
        ))}
        {q.data && q.data.items.length === 0 ? <p className="p-3 text-[13px] text-muted-foreground">You have no agents yet.</p> : null}
      </nav>
      <p className="px-1 text-xs text-muted-foreground">Agents act with your grants, optionally narrowed. Audit records “agent on behalf of you”.</p>
    </aside>
  );
}

function AgentDetailPage() {
  const { agentId } = Route.useParams();
  const { tab = 'keys' } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const me = useMe();
  const qc = useQueryClient();
  const q = useQuery(agentQuery(agentId));
  const [editing, setEditing] = useState(false);
  const [creatingKey, setCreatingKey] = useState(false);
  const [newAgent, setNewAgent] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const agent = q.data;
  const isOwner = agent?.owner.id === me.user.id;
  const canWrite = isOwner;
  const del = useMutation({
    mutationFn: () => apiFetch(api.agents.delete, { params: { id: agentId } }),
    onSuccess: () => {
      notifySuccess(`Agent “${agent?.name}” deleted`);
      void qc.invalidateQueries({ queryKey: agentKeys.all });
      void navigate({ to: '/agents' });
    },
    onError: (err) => notifyError(err, 'Could not delete the agent'),
  });

  return (
    <div className="flex w-full max-w-screen-2xl flex-col items-start gap-6 lg:flex-row">
      <MyAgentsAside activeId={agentId} onNew={() => setNewAgent(true)} />
      <section className="flex w-full min-w-0 flex-1 flex-col gap-5">
        {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
        {!agent && !q.error ? <Skeleton className="h-16 w-full" /> : null}
        {agent ? (
          <>
            <PageHeader
              title={agent.name}
              description={
                <span className="flex flex-col gap-1">
                  <span>{agent.description || 'No description.'}</span>
                  {!isOwner ? <span className="text-[13px]">Owner: {agent.owner.name}</span> : null}
                </span>
              }
              actions={
                canWrite ? (
                  <>
                    <Button variant="outline" onClick={() => setEditing(true)}>
                      Edit
                    </Button>
                    {agent.kind === 'api' ? <Button onClick={() => setCreatingKey(true)}>Create key</Button> : null}
                  </>
                ) : undefined
              }
            />
            <div className="-mt-3 flex gap-2">
              <Pill tone="muted">{agentKindLabel(agent)}</Pill>
              {agent.status === 'disabled' ? <Pill tone="err">Disabled</Pill> : null}
            </div>
            <Tabs value={tab} onValueChange={(v) => void navigate({ search: { tab: v === 'keys' ? undefined : (v as Tab) }, replace: true })}>
              <TabsList aria-label="Agent sections">
                <TabsTrigger value="keys">Keys</TabsTrigger>
                <TabsTrigger value="scope">Scope</TabsTrigger>
                <TabsTrigger value="apps">Authorized apps</TabsTrigger>
                <TabsTrigger value="activity">Activity</TabsTrigger>
              </TabsList>
              <TabsContent value="keys" className="pt-2">
                <KeysTable agentId={agentId} canWrite={canWrite} onCreate={() => setCreatingKey(true)} />
              </TabsContent>
              <TabsContent value="scope" className="flex flex-col gap-5 pt-2">
                <ScopePanel agentId={agentId} canWrite={canWrite} />
                <EffectiveAccess agentId={agentId} />
              </TabsContent>
              <TabsContent value="apps" className="pt-2">
                <AuthorizedApps agentId={agentId} canWrite={canWrite} />
              </TabsContent>
              <TabsContent value="activity" className="pt-2">
                <RecentActivity filter={{ agentId, ...(can(me, 'audit:read') ? {} : { scope: 'me' as const }) }} {...(can(me, 'audit:read') ? { auditLink: { agentId } } : {})} />
              </TabsContent>
            </Tabs>
            {canWrite ? (
              <div className="flex flex-wrap items-center gap-4 rounded-xl border border-destructive/30 bg-card p-4">
                <div className="flex min-w-72 flex-1 flex-col gap-0.5">
                  <h2 className="text-[15px] font-semibold">Delete agent</h2>
                  <p className="text-[13.5px] text-muted-foreground">Revokes all keys and authorized apps. Audit history is kept. You'll be asked to type the agent name.</p>
                </div>
                <Button variant="outline" className="border-destructive/30 text-destructive hover:bg-destructive-muted hover:text-destructive" onClick={() => setDeleting(true)}>
                  Delete {agent.name}
                </Button>
              </div>
            ) : null}
            <AgentFormDialog open={editing} onOpenChange={setEditing} agent={agent} />
            <CreateKeyDialog agent={agent} open={creatingKey} onOpenChange={setCreatingKey} />
            <ConfirmDialog
              open={deleting}
              onOpenChange={setDeleting}
              title={`Delete ${agent.name}?`}
              description="All keys and authorized apps are revoked immediately. Clients using them stop working."
              confirmLabel="Delete agent"
              confirmText={agent.name}
              pending={del.isPending}
              onConfirm={() => del.mutate()}
            />
          </>
        ) : null}
      </section>
      <AgentFormDialog open={newAgent} onOpenChange={setNewAgent} onSaved={(a) => void navigate({ to: '/agents/$agentId', params: { agentId: a.id } })} />
    </div>
  );
}
