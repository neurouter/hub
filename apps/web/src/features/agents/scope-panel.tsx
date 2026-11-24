import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type AgentScope } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { ErrorState } from '@/components/feedback/states';
import { Section } from '@/components/layout/section';
import { apiFetch } from '@/lib/api-client';
import { notifyError, notifySuccess } from '@/lib/notify';
import { agentKeys, agentScopeQuery } from './queries';

/**
 * Scope tab (§5.1): "Inherit all my access" (default) or "Restrict to…" a subset of the servers
 * the owner can use (catalog servers with access). PUT /api/agents/:id/scope.
 */
export function ScopePanel({ agentId, canWrite }: { agentId: string; canWrite: boolean }) {
  const qc = useQueryClient();
  const scope = useQuery(agentScopeQuery(agentId));
  const servers = useQuery({
    queryKey: ['catalog', 'servers', { access: 'granted' }],
    queryFn: ({ signal }) => apiFetch(api.catalog.servers, { query: { access: 'granted', limit: 200 }, signal }),
  });
  const [draft, setDraft] = useState<AgentScope | null>(null);
  const value = draft ?? scope.data;
  const save = useMutation({
    mutationFn: (body: AgentScope) => apiFetch(api.agents.setScope, { params: { id: agentId }, body }),
    onSuccess: (s) => {
      qc.setQueryData(agentKeys.scope(agentId), s);
      void qc.invalidateQueries({ queryKey: agentKeys.access(agentId) });
      setDraft(null);
      notifySuccess('Scope saved');
    },
    onError: (err) => notifyError(err, 'Could not save the scope'),
  });
  if (scope.error) return <ErrorState error={scope.error} onRetry={() => void scope.refetch()} />;
  if (!value) return <Skeleton className="h-40 w-full" />;
  const set = (patch: Partial<AgentScope>) => setDraft({ ...value, ...patch });
  return (
    <Section title="Scope" description="Agents act with your grants. Restricting narrows them further; it can never add access.">
      <div className="flex flex-col gap-4">
        <RadioGroup value={value.mode} onValueChange={(v) => set({ mode: v as AgentScope['mode'] })} disabled={!canWrite} aria-label="Scope mode">
          <div className="flex items-center gap-3">
            <RadioGroupItem value="inherit" id="scope-inherit" />
            <Label htmlFor="scope-inherit" className="font-normal">Inherit all my access</Label>
          </div>
          <div className="flex items-center gap-3">
            <RadioGroupItem value="restricted" id="scope-restricted" />
            <Label htmlFor="scope-restricted" className="font-normal">Restrict to selected servers</Label>
          </div>
        </RadioGroup>
        {value.mode === 'restricted' ? (
          <fieldset className="flex flex-col gap-2 rounded-lg border p-3" disabled={!canWrite}>
            <legend className="px-1 text-[13px] text-muted-foreground">Servers this agent may use</legend>
            {servers.isLoading ? <Skeleton className="h-16 w-full" /> : null}
            {servers.data?.items.map((s) => {
              const on = value.serverIds.includes(s.id);
              return (
                <label key={s.id} className="flex items-center gap-2.5 text-sm">
                  <Checkbox checked={on} disabled={!canWrite} onCheckedChange={(c) => set({ serverIds: c ? [...value.serverIds, s.id] : value.serverIds.filter((x) => x !== s.id) })} />
                  <span className="font-medium">{s.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">{s.slug}__*</span>
                </label>
              );
            })}
          </fieldset>
        ) : null}
        {canWrite ? (
          <div className="flex gap-2">
            <Button disabled={!draft || save.isPending} onClick={() => draft && save.mutate(draft)}>
              {save.isPending ? <Spinner /> : null}
              Save scope
            </Button>
            {draft ? (
              <Button variant="ghost" onClick={() => setDraft(null)}>
                Discard
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </Section>
  );
}
