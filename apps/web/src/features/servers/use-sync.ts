import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, SyncJobResult, type Job } from '@neurouter/shared';
import { authKeys } from '@/features/auth/queries';
import { toolKeys } from '@/features/tools/queries';
import { apiFetch } from '@/lib/api-client';
import { notifyError, notifySuccess } from '@/lib/notify';
import { serverKeys } from './queries';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls GET /api/jobs/:id until the job is terminal. */
export async function waitForJob(jobId: string, pollMs = 1000, maxPolls = 300): Promise<Job> {
  for (let i = 0; i < maxPolls; i++) {
    const job = await apiFetch(api.jobs.get, { params: { id: jobId } });
    if (job.status === 'succeeded' || job.status === 'failed') return job;
    await sleep(pollMs);
  }
  throw new Error('Sync is taking longer than expected; check the server page later.');
}

/** POST /api/servers/:id/sync → poll GET /api/jobs/:id every second until terminal (§6.4, A12). */
export async function runSync(serverId: string, pollMs = 1000, maxPolls = 300): Promise<Job> {
  const { jobId } = await apiFetch(api.servers.sync, { params: { id: serverId } });
  return waitForJob(jobId, pollMs, maxPolls);
}

/** Refreshes everything a finished sync can change (server detail and list, tools, nav badges). */
function invalidateAfterSync(qc: QueryClient, serverId: string) {
  void qc.invalidateQueries({ queryKey: serverKeys.detail(serverId) });
  void qc.invalidateQueries({ queryKey: serverKeys.all });
  void qc.invalidateQueries({ queryKey: toolKeys.all });
  void qc.invalidateQueries({ queryKey: authKeys.badges });
}

/**
 * After registering a server, follow its initial sync job in the background and refresh the
 * server page when it finishes, so discovered tools and health appear without a reload.
 */
export function useFollowInitialSync(pollMs = 1000) {
  const qc = useQueryClient();
  return (serverId: string, jobId: string) =>
    waitForJob(jobId, pollMs)
      .then((job) => {
        if (job.status === 'failed') notifyError(new Error(job.error ?? 'Sync failed'), 'Initial sync failed');
      })
      .catch(() => undefined)
      .finally(() => invalidateAfterSync(qc, serverId));
}

/** "2 new, 1 changed (needs review), 0 removed" */
export function syncSummary(result: unknown): string | null {
  const r = SyncJobResult.safeParse(result);
  if (!r.success) return null;
  return `${r.data.added} new, ${r.data.changed} changed${r.data.changed ? ' (needs review)' : ''}, ${r.data.removed} removed`;
}

export function useServerSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string; name: string }) => runSync(id),
    onSuccess: (job, { id, name }) => {
      if (job.status === 'failed') notifyError(new Error(job.error ?? 'Sync failed'), `Sync of ${name} failed`);
      else notifySuccess(`Synced ${name}`, syncSummary(job.result) ?? undefined);
      invalidateAfterSync(qc, id);
    },
    onError: (err, { name }) => notifyError(err, `Sync of ${name} failed`),
  });
}

export function useHealthCheck() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string; name: string }) => apiFetch(api.servers.healthCheck, { params: { id } }),
    onSuccess: (h, { id, name }) => {
      notifySuccess(`${name}: ${h.status}`, h.latencyMs !== null ? `${h.latencyMs} ms` : undefined);
      void qc.invalidateQueries({ queryKey: serverKeys.all });
      void qc.invalidateQueries({ queryKey: serverKeys.detail(id) });
    },
    onError: (err, { name }) => notifyError(err, `Health check of ${name} failed`),
  });
}
