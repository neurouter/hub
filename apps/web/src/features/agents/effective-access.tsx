import { useQuery } from '@tanstack/react-query';
import { ShieldQuestionIcon } from 'lucide-react';
import type { AgentAccess } from '@neurouter/shared';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { Section } from '@/components/layout/section';
import { Pill } from '@/components/status/status';
import { agentAccessQuery } from './queries';

const DECISION = { allow: { label: 'Allowed', tone: 'ok' }, deny: { label: 'Denied', tone: 'err' }, none: { label: 'No grant', tone: 'muted' } } as const;

/** "3 of 5 tools allowed" across all servers. */
export function accessSummary(a: AgentAccess): string {
  const tools = a.servers.flatMap((s) => s.tools);
  const allowed = tools.filter((t) => t.decision === 'allow').length;
  return `${allowed} of ${tools.length} tool${tools.length === 1 ? '' : 's'} allowed`;
}

/**
 * Effective access (GET /api/agents/:id/access): what this agent can call right now, after the
 * owner's grants, denies and the agent's scope are combined. Read-only; changes come from grants
 * and the scope above.
 */
export function EffectiveAccess({ agentId }: { agentId: string }) {
  const q = useQuery(agentAccessQuery(agentId));
  return (
    <Section title="Effective access" description={q.data ? `${accessSummary(q.data)}. Combines your grants, any denies and this agent’s scope.` : 'Combines your grants, any denies and this agent’s scope.'}>
      {q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data ? (
        <Skeleton className="h-24 w-full" />
      ) : !q.data.servers.length ? (
        <EmptyState icon={ShieldQuestionIcon} title="No tools yet" description="Request access to servers in the catalog; granted tools show up here." />
      ) : (
        <div className="flex flex-col gap-4">
          {q.data.servers.map((s) => (
            <div key={s.server.id} className="flex flex-col gap-1.5">
              <h3 className="text-[13.5px] font-medium">{s.server.name}</h3>
              <ul aria-label={`Tools on ${s.server.name}`} className="divide-y rounded-lg border">
                {s.tools.map((t) => (
                  <li key={t.tool.id} className="flex items-center gap-2 px-3 py-1.5">
                    <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{t.tool.qualifiedName}</span>
                    <Pill tone={DECISION[t.decision].tone}>{DECISION[t.decision].label}</Pill>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
