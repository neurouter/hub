import { createFileRoute } from '@tanstack/react-router';
import * as z from 'zod';
import { ConsentPage } from '@/features/consent/consent-page';

/**
 * MCP OAuth consent (minimal layout, frontend §4.5). The backend sends anonymous users through
 * OIDC login before redirecting here, and serves the SPA with `frame-ancestors 'none'`.
 */
export const Route = createFileRoute('/auth/consent')({
  validateSearch: z.object({ request: z.string().max(200).optional().catch(undefined) }),
  component: Consent,
});

function Consent() {
  const { request } = Route.useSearch();
  return <ConsentPage requestId={request} />;
}
