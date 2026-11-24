import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import * as z from 'zod';
import { can } from '@neurouter/shared';
import { AreaError, guard } from '@/app/route-guards';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ErrorState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { Page } from '@/components/layout/section';
import { AccessSection } from '@/features/settings/access-section';
import { AuthenticationTab } from '@/features/settings/authentication-tab';
import { ExportTab } from '@/features/settings/export-tab';
import { RedactionTab } from '@/features/settings/redaction-tab';
import { GeneralTab } from '@/features/settings/general-tab';
import { oidcSettingsQuery, settingsQuery } from '@/features/settings/queries';
import { OAuthClientsTab } from '@/features/settings/oauth-clients-tab';
import { RateLimitsTab } from '@/features/settings/rate-limits-tab';
import { SystemTab } from '@/features/settings/system-tab';
import { useMe } from '@/hooks/use-me';

const TABS = ['general', 'rate-limits', 'redaction', 'authentication', 'oauth-clients', 'export', 'system'] as const;
type Tab = (typeof TABS)[number];

export const Route = createFileRoute('/_app/admin/settings')({
  staticData: { crumbs: ['Settings', 'Gateway settings'], readOnly: { read: 'settings:read', write: 'settings:write' } },
  validateSearch: z.object({ tab: z.enum(TABS).optional().catch(undefined) }),
  beforeLoad: guard(['settings:read']),
  errorComponent: AreaError,
  component: SettingsPage,
});

function SettingsPage() {
  const me = useMe();
  const { tab = 'general' } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const readOnly = !can(me, 'settings:write');
  const settings = useQuery(settingsQuery());
  const oidc = useQuery({ ...oidcSettingsQuery(), enabled: tab === 'authentication' });
  return (
    <Page width="form">
      <PageHeader title="Gateway settings" description="Retention, limits, redaction, sign-in, OAuth clients, export and system maintenance. Every change is recorded in the audit log." />
      <Tabs value={tab} onValueChange={(v) => void navigate({ search: { tab: v === 'general' ? undefined : (v as Tab) }, replace: true })}>
        <TabsList aria-label="Settings sections" className="max-w-full overflow-x-auto">
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="rate-limits">Rate limits</TabsTrigger>
          <TabsTrigger value="redaction">Redaction</TabsTrigger>
          <TabsTrigger value="authentication">Authentication</TabsTrigger>
          <TabsTrigger value="oauth-clients">OAuth clients</TabsTrigger>
          <TabsTrigger value="export">Export</TabsTrigger>
          <TabsTrigger value="system">System</TabsTrigger>
        </TabsList>
        <TabsContent value="general" className="pt-3">
          {settings.error ? <ErrorState error={settings.error} onRetry={() => void settings.refetch()} /> : settings.data ? (
            <div className="flex flex-col gap-8">
              <GeneralTab settings={settings.data} readOnly={readOnly} />
              <AccessSection settings={settings.data} readOnly={readOnly} />
            </div>
          ) : <Skeleton className="h-64 w-full" />}
        </TabsContent>
        <TabsContent value="rate-limits" className="pt-3">
          {settings.error ? <ErrorState error={settings.error} /> : settings.data ? <RateLimitsTab settings={settings.data} readOnly={readOnly} /> : <Skeleton className="h-64 w-full" />}
        </TabsContent>
        <TabsContent value="redaction" className="pt-3">
          {tab === 'redaction' ? <RedactionTab readOnly={readOnly} /> : null}
        </TabsContent>
        <TabsContent value="authentication" className="pt-3">
          {oidc.error ? <ErrorState error={oidc.error} onRetry={() => void oidc.refetch()} /> : oidc.data ? <AuthenticationTab oidc={oidc.data} readOnly={readOnly} /> : <Skeleton className="h-64 w-full" />}
        </TabsContent>
        <TabsContent value="oauth-clients" className="pt-3">
          {tab === 'oauth-clients' ? <OAuthClientsTab readOnly={readOnly} /> : null}
        </TabsContent>
        <TabsContent value="system" className="pt-3">
          {tab === 'system' ? <SystemTab readOnly={readOnly} /> : null}
        </TabsContent>
        <TabsContent value="export" className="pt-3">
          {settings.error ? <ErrorState error={settings.error} /> : settings.data ? <ExportTab settings={settings.data} readOnly={readOnly} /> : <Skeleton className="h-64 w-full" />}
        </TabsContent>
      </Tabs>
    </Page>
  );
}
