import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckIcon, ClockIcon, InfoIcon, MonitorIcon, ShieldCheckIcon, TriangleAlertIcon } from 'lucide-react';
import { api, type ConsentRequest } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Pill } from '@/components/status/status';
import { signOut } from '@/components/layout/user-menu';
import { meQueryOptions } from '@/features/auth/queries';
import { ApiError, apiFetch } from '@/lib/api-client';
import { errorMessage } from '@/lib/notify';
import { browserNavigation } from '@/lib/navigation';
import { serverClock } from '@/lib/server-time';

export const consentKeys = { request: (id: string) => ['oauth', 'consent', id] as const };

/** Default agent name for a new binding: "<client-slug> @ <email local part>" (prototype). */
export function defaultAgentName(clientName: string, email: string): string {
  const slug = clientName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'mcp-client';
  const who = email.split('@')[0] ?? email;
  return `${slug} @ ${who}`.slice(0, 100);
}

/** Minutes until the request expires, by the server clock (never negative). */
export function minutesLeft(expiresAt: string, serverNow: number): number {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - serverNow) / 60_000));
}

/** Logos only render from our own origin (CSP img-src 'self'; the backend proxies icons, Q9). */
export function safeLogo(uri: string | null): string | null {
  return uri && uri.startsWith('/') && !uri.startsWith('//') ? uri : null;
}

function Shell({ org, children }: { org?: string | undefined; children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col items-center gap-6 bg-background px-4 py-12">
      <div className="flex items-center gap-2.5">
        <div aria-hidden="true" className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 19V5l14 14V5" />
          </svg>
        </div>
        <span className="text-base font-semibold">Neurouter Hub</span>
        {org ? <span className="text-muted-foreground">· {org}</span> : null}
      </div>
      <main className="flex w-full max-w-[520px] flex-col gap-[18px] rounded-[14px] border bg-card p-5 shadow-xs sm:p-7">{children}</main>
    </div>
  );
}

function Row({ label, children, stacked, last }: { label: ReactNode; children: ReactNode; stacked?: boolean; last?: boolean }) {
  return (
    <div className={`flex gap-3 py-3 ${last ? '' : 'border-b'} ${stacked ? 'flex-col gap-2' : 'flex-col items-start sm:flex-row'}`}>
      <span className="w-[120px] shrink-0 pt-px text-[13px] text-muted-foreground">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function RegistrationBadge({ client }: { client: ConsentRequest['client'] }) {
  if (client.registration === 'cimd' && client.verified)
    return (
      <Pill tone="ok" icon={CheckIcon}>
        Verified metadata document (CIMD)
      </Pill>
    );
  if (client.registration === 'preregistered')
    return (
      <Pill tone={client.verified ? 'info' : 'warn'} icon={client.verified ? InfoIcon : TriangleAlertIcon}>
        {client.verified ? 'Registered by your administrator' : 'Unverified app'}
      </Pill>
    );
  return (
    <Pill tone="warn" icon={TriangleAlertIcon}>
      Unverified app · dynamically registered
    </Pill>
  );
}

const NEW = '__new__';

/**
 * MCP OAuth consent (frontend §4.5, prototype Consent.dc.html, addendum #7). Shows the client_id
 * host and the redirect host verbatim, warns for unverified apps, binds the client to an agent,
 * and leaves with `location.replace(redirectTo)`. Names are rendered as text only.
 */
export function ConsentPage({ requestId }: { requestId: string | undefined }) {
  const qc = useQueryClient();
  const me = useQuery({ ...meQueryOptions(), retry: false });
  const q = useQuery({
    queryKey: consentKeys.request(requestId ?? ''),
    queryFn: ({ signal }) => apiFetch(api.oauth.getConsent, { params: { requestId: requestId! }, signal }),
    enabled: !!requestId,
    retry: false,
    staleTime: Infinity,
  });
  const [agent, setAgent] = useState<string>(NEW);
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'deny') => {
      const c = q.data!;
      const binding = decision === 'approve' ? (agent === NEW ? { agentName: defaultAgentName(c.client.name, c.user.email) } : { agentId: agent }) : {};
      return apiFetch(api.oauth.decideConsent, { params: { requestId: requestId! }, body: { decision, ...binding } });
    },
    onSuccess: (r) => browserNavigation.replace(r.redirectTo),
  });
  const org = me.data?.org.name;

  if (!requestId) return <ConsentError org={org} title="Missing authorization request" body="Return to your app and start the connection again." />;
  if (q.isLoading)
    return (
      <Shell org={org}>
        <Skeleton className="h-12 w-3/4" />
        <Skeleton className="h-64 w-full" />
      </Shell>
    );
  if (q.error) {
    const status = q.error instanceof ApiError ? q.error.status : 0;
    if (status === 410 || status === 404)
      return <ConsentError org={org} icon={ClockIcon} title="This authorization request has expired" body="Return to your app and try again." />;
    if (status === 403)
      return (
        <ConsentError
          org={org}
          title="This request belongs to a different account"
          body="The app started this sign-in for someone else. Sign out and sign in with the account you used in the app."
          action={
            <Button variant="outline" onClick={() => void signOut(qc)}>
              Sign out
            </Button>
          }
        />
      );
    return <ConsentError org={org} title="Couldn't load this request" body={errorMessage(q.error)} action={<Button variant="outline" onClick={() => void q.refetch()}>Try again</Button>} />;
  }
  const c = q.data!;
  const unverified = !c.client.verified;
  const busy = decide.isPending || decide.isSuccess;
  const newName = defaultAgentName(c.client.name, c.user.email);
  const logo = c.client.verified ? safeLogo(c.client.logoUri) : null;
  const mins = minutesLeft(c.expiresAt, serverClock.now());
  const agentItems = [{ value: NEW, label: `New agent: ${newName}` }, ...c.agents.map((a) => ({ value: a.id, label: a.name }))];

  return (
    <Shell org={org}>
      <div className="flex items-center gap-3.5">
        <div aria-hidden="true" className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-xl border bg-muted text-muted-foreground">
          {logo ? <img src={logo} alt="" className="size-full object-cover" /> : <MonitorIcon className="size-[22px]" />}
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-[19px] font-semibold tracking-tight break-words">
            {c.client.name} wants to use Neurouter Hub as you
          </h1>
          <div className="flex flex-wrap items-center gap-1.5">
            <RegistrationBadge client={c.client} />
          </div>
        </div>
      </div>

      {unverified ? (
        <div role="alert" className="flex gap-2.5 rounded-[10px] border border-warning/30 bg-warning-muted px-3.5 py-3 text-[13.5px]">
          <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
          <div className="flex flex-col gap-0.5">
            <span className="font-semibold text-warning">Neurouter Hub couldn't verify who made this app</span>
            <span>The name and details below were supplied by the app itself. Only approve if you started this connection and recognise the redirect address.</span>
          </div>
        </div>
      ) : null}

      <div className="flex flex-col border-t">
        <Row label="App ID">
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="font-mono text-sm font-semibold break-all">{c.client.idHost ?? `${c.client.name} (self-declared)`}</span>
            <span className="font-mono text-xs break-all text-muted-foreground">{c.client.idHost ? c.client.id : `client_id ${c.client.id}`}</span>
          </span>
        </Row>
        <Row label="After approving">
          <span>
            You'll be sent to <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm font-semibold break-all">{c.redirectHost}</span>
            {c.localhostOnly ? <span className="mt-1 block text-[12.5px] text-muted-foreground">An app running on this computer.</span> : null}
          </span>
        </Row>
        <Row label="Resource">
          <span className="font-mono text-[12.5px] break-all">{c.resource}</span>
        </Row>
        <Row label="It will be able to" stacked>
          <ul className="flex flex-col gap-2" aria-label="Requested permissions">
            {c.scopes.map((s) => (
              <li key={s.name} className="flex gap-2.5">
                <ShieldCheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
                <span>
                  <span className="font-medium">{s.description}</span>
                  <br />
                  <span className="font-mono text-xs text-muted-foreground">{s.name}</span>
                </span>
              </li>
            ))}
          </ul>
        </Row>
        <Row label={<label htmlFor="consent-agent">Appears in audit as agent</label>} stacked>
          <Select value={agent} onValueChange={(v) => setAgent(v ?? NEW)} items={agentItems} disabled={busy}>
            <SelectTrigger id="consent-agent" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={NEW}>New agent: {newName}</SelectItem>
              </SelectGroup>
              {c.agents.length ? (
                <SelectGroup>
                  <SelectLabel>Your agents</SelectLabel>
                  {c.agents.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ) : null}
            </SelectContent>
          </Select>
        </Row>
        <Row label="Signed in as" last>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="flex-1 break-all">{c.user.email}</span>
            <button type="button" className="text-[13px] underline underline-offset-4 hover:text-muted-foreground" onClick={() => void signOut(qc)}>
              Not you? Sign out
            </button>
          </span>
        </Row>
      </div>

      {decide.error ? (
        <p role="alert" className="text-[13px] text-destructive">
          {decide.error instanceof ApiError && (decide.error.status === 410 || decide.error.status === 404)
            ? 'This authorization request has expired. Return to your app and try again.'
            : errorMessage(decide.error)}
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-2.5">
        <Button variant="outline" size="lg" disabled={busy} onClick={() => decide.mutate('deny')}>
          {decide.isPending && decide.variables === 'deny' ? <Spinner /> : null}
          Deny
        </Button>
        <Button size="lg" disabled={busy} onClick={() => decide.mutate('approve')}>
          {decide.isPending && decide.variables === 'approve' ? <Spinner /> : null}
          Approve
        </Button>
      </div>
      <p className="text-center text-[12.5px] text-muted-foreground">
        {mins > 0 ? `This request expires in ${mins} minute${mins === 1 ? '' : 's'}. ` : ''}You can revoke access later under My agents → Authorized apps.
      </p>
    </Shell>
  );
}

function ConsentError({ org, title, body, action, icon: Icon = TriangleAlertIcon }: { org?: string | undefined; title: string; body: string; action?: ReactNode; icon?: typeof ClockIcon }) {
  return (
    <Shell org={org}>
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <span className="flex size-11 items-center justify-center rounded-xl bg-muted">
          <Icon aria-hidden="true" className="size-5" />
        </span>
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="max-w-sm text-muted-foreground">{body}</p>
        {action}
      </div>
    </Shell>
  );
}
