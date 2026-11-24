import { useCallback } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import * as z from 'zod';
import { PageHeader } from '@/components/layout/page-header';
import { Page } from '@/components/layout/section';
import { ConnectionsList } from '@/features/connections/connections';

const search = z.object({
  connected: z.string().max(100).optional().catch(undefined),
  error: z.string().max(100).optional().catch(undefined),
  server: z.string().max(100).optional().catch(undefined),
});

export const Route = createFileRoute('/_app/connections')({
  staticData: { crumbs: ['Portal', 'Connections'] },
  validateSearch: search,
  component: ConnectionsPage,
});

function ConnectionsPage() {
  const s = Route.useSearch();
  const navigate = Route.useNavigate();
  // strip the OAuth return params once they have been shown (§4.6)
  const consumed = useCallback(() => void navigate({ search: {}, replace: true }), [navigate]);
  return (
    <Page width="form">
      <PageHeader title="Connections" description="Upstream accounts linked with per-user OAuth. Agents acting as you use these accounts when they call those servers." />
      <ConnectionsList returned={s} onConsumed={consumed} />
    </Page>
  );
}
