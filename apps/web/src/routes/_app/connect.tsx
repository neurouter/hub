import { useState } from 'react';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import * as z from 'zod';
import { api } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CodeSnippet } from '@/components/code/code-snippet';
import { ErrorState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { DetailList, Section } from '@/components/layout/section';
import { Pill } from '@/components/status/status';
import { AgentFormDialog } from '@/features/agents/agent-form-dialog';
import { CreateKeyDialog } from '@/features/agents/create-key-dialog';
import { agentsListQuery } from '@/features/agents/queries';
import { CLIENTS, buildSnippet, type AuthMode, type ClientId } from '@/features/client-config/templates';
import { apiFetch } from '@/lib/api-client';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/_app/connect')({
  staticData: { crumbs: ['Portal', 'Connect a client'] },
  validateSearch: z.object({
    agentId: z.string().optional().catch(undefined),
    auth: z.enum(['oauth', 'api_key']).optional().catch(undefined),
    client: z.enum(['claude', 'cursor', 'vscode', 'generic']).optional().catch(undefined),
  }),
  component: ConnectPage,
});

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="flex gap-4" aria-labelledby={`step-${n}`}>
      <span aria-hidden="true" className="inline-flex size-7 shrink-0 items-center justify-center rounded-full border text-[13px] font-semibold">
        {n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <h2 id={`step-${n}`} className="text-[15px] font-semibold">
          {title}
        </h2>
        {children}
      </div>
    </section>
  );
}

function AuthOption({ checked, onSelect, title, badge, hint }: { checked: boolean; onSelect: () => void; title: string; badge?: React.ReactNode; hint: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={cn('flex flex-1 items-start gap-3 rounded-xl border p-3 text-left transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50', checked ? 'border-foreground ring-1 ring-foreground' : 'hover:bg-muted/50')}
    >
      <span aria-hidden="true" className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full border">
        {checked ? <span className="size-2 rounded-full bg-foreground" /> : null}
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="flex items-center gap-2 font-medium">
          {title} {badge}
        </span>
        <span className="text-[13px] text-muted-foreground">{hint}</span>
      </span>
    </button>
  );
}

/** Connect a client (§5.1, prototype Connect.dc.html): agent → sign-in method → per-client snippet. */
function ConnectPage() {
  const s = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const cfg = useQuery({ queryKey: ['portal', 'client-config'], queryFn: ({ signal }) => apiFetch(api.portal.clientConfig, { signal }), staleTime: 5 * 60_000 });
  const agents = useQuery(agentsListQuery({ owner: 'me', limit: 200 }));
  const [key, setKey] = useState('');
  const [creatingAgent, setCreatingAgent] = useState(false);
  const [creatingKey, setCreatingKey] = useState(false);
  const set = (p: Partial<typeof s>) => void navigate({ search: (prev) => ({ ...prev, ...p }), replace: true });
  const agent = agents.data?.items.find((a) => a.id === s.agentId) ?? agents.data?.items[0];
  const oauthOk = cfg.data?.oauthSupported ?? true;
  const auth: AuthMode = s.auth ?? (oauthOk ? 'oauth' : 'api_key');
  const client: ClientId = s.client ?? 'claude';
  const snippet = cfg.data ? buildSnippet(client, { config: cfg.data, auth, key: auth === 'api_key' && key.trim() ? key.trim() : undefined, agentName: agent?.name }) : null;
  const agentItems = (agents.data?.items ?? []).map((a) => ({ value: a.id, label: a.name }));
  return (
    <div className="flex w-full max-w-screen-2xl flex-col gap-5">
      <PageHeader title="Connect a client" description="Point any MCP client at one Neurouter Hub endpoint. You'll only see the tools you're allowed to use." />
      {cfg.error ? <ErrorState error={cfg.error} onRetry={() => void cfg.refetch()} /> : null}
      <div className="flex flex-col items-start gap-6 lg:flex-row">
        <div className="flex w-full min-w-0 flex-1 flex-col gap-7">
          <Step n={1} title="Choose the agent this client acts as">
            <div className="flex flex-wrap items-center gap-2">
              {agents.isLoading ? <Skeleton className="h-9 w-56" /> : null}
              {agentItems.length ? (
                <Select value={agent?.id ?? ''} onValueChange={(v) => set({ agentId: String(v) })} items={agentItems}>
                  <SelectTrigger aria-label="Agent" className="h-9 min-w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {agentItems.map((a) => (
                      <SelectItem key={a.value} value={a.value}>
                        {a.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : agents.data ? (
                <span className="text-[13.5px] text-muted-foreground">You have no agents yet.</span>
              ) : null}
              <Button variant="ghost" size="sm" onClick={() => setCreatingAgent(true)}>
                Create agent
              </Button>
            </div>
          </Step>
          <Step n={2} title="How the client signs in">
            <div role="radiogroup" aria-label="Auth method" className="flex flex-col gap-2 sm:flex-row">
              {oauthOk ? (
                <AuthOption checked={auth === 'oauth'} onSelect={() => set({ auth: 'oauth' })} title="OAuth" badge={<Pill tone="ok">Recommended</Pill>} hint="For interactive clients. The client opens a browser, you approve once, no key to copy." />
              ) : null}
              <AuthOption checked={auth === 'api_key'} onSelect={() => set({ auth: 'api_key' })} title="API key" hint="For headless agents and CI. Read the key from an environment variable." />
            </div>
            {auth === 'api_key' ? (
              <div className="flex flex-wrap items-end gap-2">
                <div className="flex min-w-64 flex-1 flex-col gap-1.5">
                  <Label htmlFor="paste-key">Paste API key (optional)</Label>
                  <Input id="paste-key" type="password" autoComplete="off" className="font-mono" placeholder="Paste a key to fill the snippet (optional)" value={key} onChange={(e) => setKey(e.target.value)} />
                </div>
                <span className="pb-2 text-[13px] text-muted-foreground">or</span>
                <Button variant="outline" size="sm" className="mb-0.5" disabled={!agent || agent.kind !== 'api'} onClick={() => setCreatingKey(true)}>
                  Create a new key
                </Button>
              </div>
            ) : null}
          </Step>
          <Step n={3} title="Add Neurouter Hub to your client">
            <Tabs value={client} onValueChange={(v) => set({ client: v as ClientId })}>
              <TabsList aria-label="Client">
                {CLIENTS.map((c) => (
                  <TabsTrigger key={c.id} value={c.id}>
                    {c.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            {snippet ? <CodeSnippet code={snippet.code} label={snippet.targetLabel} target={snippet.target} footer={snippet.hint} /> : <Skeleton className="h-40 w-full" />}
          </Step>
        </div>
        <aside className="flex w-full flex-col gap-4 lg:w-80">
          <Section title="Endpoint">
            {cfg.data ? (
              <DetailList
                items={[
                  { label: 'MCP URL', value: <span className="font-mono text-[12.5px] break-all">{cfg.data.mcpUrl}</span> },
                  { label: 'Transport', value: 'Streamable HTTP' },
                  { label: 'Protocol', value: <span className="font-mono text-[12.5px]">{cfg.data.protocolVersions.join(', ')}</span> },
                  { label: 'Tools exposed', value: <span className="font-mono text-[12.5px]">search_tools, call_tool</span> },
                ]}
              />
            ) : (
              <Skeleton className="h-24 w-full" />
            )}
          </Section>
          <Section title="Check it works">
            <ol className="ml-4 flex list-decimal flex-col gap-1.5 text-[13.5px]">
              <li>Restart or reload your client.</li>
              <li>
                Ask it to list tools: you should see <span className="font-mono">search_tools</span> and <span className="font-mono">call_tool</span>.
              </li>
              <li>
                Calls show up under{' '}
                <Link to="/activity" className="font-medium underline-offset-4 hover:underline">
                  My activity
                </Link>{' '}
                within a minute.
              </li>
            </ol>
          </Section>
        </aside>
      </div>
      <AgentFormDialog open={creatingAgent} onOpenChange={setCreatingAgent} onSaved={(a) => set({ agentId: a.id })} />
      {agent ? <CreateKeyDialog agent={agent} open={creatingKey} onOpenChange={setCreatingKey} onCreated={(secret) => setKey(secret)} /> : null}
    </div>
  );
}
