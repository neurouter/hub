import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CircleCheckIcon, OctagonXIcon, ShieldCheckIcon } from 'lucide-react';
import { api } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import { ErrorState } from '@/components/feedback/states';
import { apiFetch } from '@/lib/api-client';
import { formatDuration, formatNumber } from '@/lib/format';
import { jobQuery, verifyResult } from './queries';

/**
 * "Verify integrity" (§5.3): POST /api/audit/verify → job, polled every second; renders the
 * verified or broken-chain result (with a link to the offending entry).
 */
export function VerifyDialog() {
  const [open, setOpen] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: () => apiFetch(api.audit.verify, { body: {} }),
    onSuccess: (r) => setJobId(r.jobId),
  });
  const job = useQuery(jobQuery(jobId));
  const result = verifyResult(job.data);
  const running = start.isPending || (!!jobId && (!job.data || job.data.status === 'queued' || job.data.status === 'running'));
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setJobId(null);
          start.reset();
        }
      }}
    >
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <ShieldCheckIcon /> Verify integrity…
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Verify audit chain</DialogTitle>
          <DialogDescription>Recomputes the hash chain over the entire retained log and checks signed checkpoints.</DialogDescription>
        </DialogHeader>
        {start.error ? <ErrorState error={start.error} /> : null}
        {running ? (
          <div className="flex flex-col gap-2" aria-live="polite">
            <span className="flex items-center gap-2 text-sm">
              <Spinner /> Verifying…
            </span>
            <Progress value={job.data?.progress !== null && job.data?.progress !== undefined ? job.data.progress * 100 : null} aria-label="Verification progress" />
          </div>
        ) : null}
        {job.data?.status === 'failed' ? <p className="text-sm text-destructive">Verification failed: {job.data.error}</p> : null}
        {result?.ok ? (
          <div role="status" className="flex gap-2.5 rounded-lg border border-success/30 bg-success-muted p-3 text-success">
            <CircleCheckIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <p className="text-sm">
              Verified {formatNumber(result.checked)} entries (seq {formatNumber(result.firstSeq)}–{formatNumber(result.lastSeq)}) in {formatDuration(result.durationMs)}.
            </p>
          </div>
        ) : null}
        {result && !result.ok && result.brokenAt ? (
          <div role="alert" className="flex gap-2.5 rounded-lg border border-destructive/30 bg-destructive-muted p-3 text-destructive">
            <OctagonXIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <div className="flex flex-col gap-1 text-sm">
              <p className="font-medium">
                Chain broken at seq {formatNumber(result.brokenAt.seq)} ({result.brokenAt.reason.replaceAll('_', ' ')}).
              </p>
              {result.brokenAt.expected ? <p className="font-mono text-xs break-all text-foreground">expected {result.brokenAt.expected}</p> : null}
              {result.brokenAt.eventId ? (
                <Link to="/audit" search={{ event: result.brokenAt.eventId }} className="font-medium underline underline-offset-4" onClick={() => setOpen(false)}>
                  Open entry
                </Link>
              ) : null}
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Close
          </Button>
          <Button disabled={running} onClick={() => start.mutate()}>
            {result ? 'Verify again' : 'Start verification'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
