import { useState } from 'react';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { BotIcon, PlusIcon } from 'lucide-react';
import type { Agent } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { DataTable, type ColumnSpec } from '@/components/data-table/data-table';
import { EmptyState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { Page } from '@/components/layout/section';
import { Pill } from '@/components/status/status';
import { AgentFormDialog } from '@/features/agents/agent-form-dialog';
import { agentsListQuery } from '@/features/agents/queries';
import { formatDate, formatNumber, formatRelative } from '@/lib/format';

export const Route = createFileRoute('/_app/agents/')({
  staticData: { crumbs: ['Portal', 'My agents'] },
  component: MyAgentsPage,
});

export function agentKindLabel(a: Pick<Agent, 'kind'>): string {
  return a.kind === 'oauth_client' ? 'OAuth client' : 'Headless · API keys';
}

function MyAgentsPage() {
  const navigate = useNavigate();
  const q = useQuery(agentsListQuery({ owner: 'me', limit: 200 }));
  const [creating, setCreating] = useState(false);
  const columns: ColumnSpec<Agent>[] = [
    {
      id: 'name',
      header: 'Agent',
      priority: 1,
      cell: (a) => (
        <span className="flex flex-col">
          <Link to="/agents/$agentId" params={{ agentId: a.id }} className="font-medium underline-offset-4 hover:underline">
            {a.name}
          </Link>
          {a.description ? <span className="max-w-md truncate text-xs text-muted-foreground">{a.description}</span> : null}
        </span>
      ),
    },
    { id: 'kind', header: 'Type', priority: 2, cell: (a) => <Pill tone="muted">{agentKindLabel(a)}</Pill> },
    { id: 'keys', header: 'Active keys', align: 'right', priority: 2, cell: (a) => formatNumber(a.activeKeyCount) },
    { id: 'used', header: 'Last used', priority: 2, cell: (a) => <span className="text-muted-foreground">{formatRelative(a.lastUsedAt)}</span> },
    { id: 'created', header: 'Created', cell: (a) => <span className="text-muted-foreground">{formatDate(a.createdAt)}</span> },
  ];
  return (
    <Page>
      <PageHeader
        title="My agents"
        description="Agent identities you own. Each one calls tools on your behalf with its own keys or OAuth apps."
        actions={
          <Button onClick={() => setCreating(true)}>
            <PlusIcon /> New agent
          </Button>
        }
      />
      <DataTable
        label="My agents"
        columns={columns}
        rows={q.data?.items}
        getRowId={(a) => a.id}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        onRowClick={(a) => void navigate({ to: '/agents/$agentId', params: { agentId: a.id } })}
        empty={<EmptyState icon={BotIcon} title="No agents yet" description="Create your first agent to get an API key." action={<Button onClick={() => setCreating(true)}>New agent</Button>} />}
      />
      <AgentFormDialog open={creating} onOpenChange={setCreating} onSaved={(a) => void navigate({ to: '/agents/$agentId', params: { agentId: a.id } })} />
    </Page>
  );
}
