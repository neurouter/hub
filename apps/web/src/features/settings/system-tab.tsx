import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Job, type SystemInfo } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { ErrorState } from '@/components/feedback/states';
import { DetailList, Section } from '@/components/layout/section';
import { Pill } from '@/components/status/status';
import { isTerminal, jobQuery } from '@/features/audit/queries';
import { apiFetch } from '@/lib/api-client';
import { formatNumber } from '@/lib/format';
import { notifyError, notifySuccess } from '@/lib/notify';
import { systemInfoQuery, systemKeys } from './queries';

type Action = 'reindex' | 'dek' | 'rewrap';
const ACTIONS: Record<Action, { title: string; description: string; confirm: string; done: string }> = {
  reindex: {
    title: 'Re-embed every tool?',
    description: 'Search keeps working in keyword mode while the index is rebuilt. This can take a few minutes for large catalogs.',
    confirm: 'Rebuild index',
    done: 'Search index rebuilt',
  },
  dek: {
    title: 'Rotate the data encryption key?',
    description: 'A new data key encrypts new secrets; existing secrets are re-encrypted with it in the background. Upstream credentials keep working throughout.',
    confirm: 'Rotate data key',
    done: 'Data key rotated',
  },
  rewrap: {
    title: 'Re-wrap data keys under the active master key?',
    description: 'Run this after adding a new KEK to the key file and restarting. Data keys are re-wrapped; secrets themselves are not re-encrypted.',
    confirm: 'Re-wrap keys',
    done: 'Data keys re-wrapped',
  },
};

/** Index coverage as "3 of 3 tools embedded" (keyword-only deployments have no coverage). */
export function indexCoverage(info: Pick<SystemInfo, 'searchMode' | 'searchIndex'>): string {
  if (!info.searchIndex) return '—';
  const { tools, embedded } = info.searchIndex;
  if (info.searchMode === 'keyword') return `${formatNumber(tools)} tools (keyword search only)`;
  return `${formatNumber(embedded)} of ${formatNumber(tools)} tools embedded`;
}

function JobLine({ job }: { job: Job | undefined }) {
  if (!job) return <span className="inline-flex items-center gap-2 text-[13px] text-muted-foreground"><Spinner /> Starting…</span>;
  if (job.status === 'failed') return <Pill tone="err">Failed{job.error ? ` · ${job.error}` : ''}</Pill>;
  if (job.status === 'succeeded') return <Pill tone="ok">Done</Pill>;
  return (
    <span className="inline-flex items-center gap-2 text-[13px] text-muted-foreground">
      <Spinner /> {job.status === 'queued' ? 'Queued' : `Running${job.progress !== null ? ` · ${Math.round(job.progress * 100)}%` : ''}`}
    </span>
  );
}

/**
 * System (admin): runtime info from GET /api/system/info and the two maintenance jobs, re-embedding
 * the search index and rotating / re-wrapping encryption keys. Jobs are polled via /api/jobs/:id.
 */
export function SystemTab({ readOnly }: { readOnly: boolean }) {
  const qc = useQueryClient();
  const info = useQuery(systemInfoQuery());
  const [confirm, setConfirm] = useState<Action | null>(null);
  const [running, setRunning] = useState<{ action: Action; jobId: string } | null>(null);
  const job = useQuery(jobQuery(running?.jobId ?? null));
  const busy = !!running && !(job.data && isTerminal(job.data));
  const start = useMutation({
    mutationFn: (a: Action) => (a === 'reindex' ? apiFetch(api.system.reindex, {}) : apiFetch(api.system.rotateKeys, { body: { type: a } })),
    onSuccess: (r, a) => {
      setConfirm(null);
      setRunning({ action: a, jobId: r.jobId });
    },
    onError: (err) => notifyError(err, 'Could not start the job'),
  });
  const [notified, setNotified] = useState<string | null>(null);
  if (running && job.data && isTerminal(job.data) && notified !== running.jobId) {
    setNotified(running.jobId);
    if (job.data.status === 'succeeded') notifySuccess(ACTIONS[running.action].done);
    else notifyError(new Error(job.data.error ?? 'Job failed'), 'Job failed');
    void qc.invalidateQueries({ queryKey: systemKeys.info });
  }

  if (info.error) return <ErrorState error={info.error} onRetry={() => void info.refetch()} />;
  if (!info.data) return <Skeleton className="h-64 w-full" />;
  const i = info.data;
  const statusFor = (a: Action) => (running?.action === a ? <JobLine job={job.data} /> : null);
  return (
    <div className="flex flex-col gap-5">
      <Section title="Runtime" description="Read-only. Configuration comes from environment variables.">
        <DetailList
          items={[
            { label: 'Version', value: <span className="font-mono">{i.version}</span> },
            { label: 'Database', value: i.dbDialect === 'postgres' ? 'PostgreSQL' : i.dbDialect === 'sqlite' ? 'SQLite' : '—' },
            { label: 'Instance', value: <span className="font-mono">{i.instanceId ?? '—'}</span> },
            { label: 'MCP endpoint', value: <span className="font-mono break-all">{i.mcpUrl}</span> },
            { label: 'Protocol versions', value: i.protocolVersions.join(', ') },
          ]}
        />
      </Section>
      <Section
        title="Tool search"
        description="Hybrid search combines keyword and embedding similarity; it falls back to keyword search while the model loads."
        actions={
          readOnly ? null : (
            <Button variant="outline" size="sm" disabled={busy || i.searchMode !== 'hybrid'} onClick={() => setConfirm('reindex')}>
              Rebuild index…
            </Button>
          )
        }
      >
        <DetailList
          items={[
            { label: 'Mode', value: i.searchMode === 'hybrid' ? <Pill tone="ok">Hybrid</Pill> : <Pill tone="muted">Keyword</Pill> },
            { label: 'Embedding model', value: <span className="font-mono">{i.embeddingModel ?? '—'}</span> },
            { label: 'Model', value: i.embeddingReady === undefined ? '—' : i.embeddingReady ? 'Ready' : 'Loading…' },
            { label: 'Index', value: indexCoverage(i) },
          ]}
        />
        {statusFor('reindex') ? <div className="mt-3">{statusFor('reindex')}</div> : null}
      </Section>
      {!readOnly ? (
        <Section title="Encryption keys" description="Upstream credentials are encrypted with a data key (DEK) wrapped by the master key (KEK) from the key file.">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirm('dek')}>
              Rotate data key…
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirm('rewrap')}>
              Re-wrap under active KEK…
            </Button>
            {statusFor('dek') ?? statusFor('rewrap')}
          </div>
        </Section>
      ) : null}
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        destructive={false}
        title={confirm ? ACTIONS[confirm].title : ''}
        description={confirm ? ACTIONS[confirm].description : ''}
        confirmLabel={confirm ? ACTIONS[confirm].confirm : ''}
        pending={start.isPending}
        onConfirm={() => confirm && start.mutate(confirm)}
      />
    </div>
  );
}
