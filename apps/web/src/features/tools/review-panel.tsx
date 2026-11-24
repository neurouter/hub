import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type DefinitionDiff, type ToolDetail } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { DiffView, WordDiffText } from '@/components/code/diff-view';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { ErrorState } from '@/components/feedback/states';
import { Segmented } from '@/components/filters/segmented';
import { Pill } from '@/components/status/status';
import { authKeys } from '@/features/auth/queries';
import { serverKeys } from '@/features/servers/queries';
import { useMinWidth } from '@/hooks/use-min-width';
import { ApiError, apiFetch } from '@/lib/api-client';
import { lineDiff, wordDiff } from '@/lib/diff';
import { formatDate, shortHash } from '@/lib/format';
import { stableStringify } from '@/lib/json';
import { notifyError, notifySuccess } from '@/lib/notify';
import { summarizeDefinitionChange } from './definition-change';
import { definitionDiffQuery, toolKeys } from './queries';

function annotationText(a: Record<string, unknown> | null): string {
  if (!a) return '';
  return Object.keys(a)
    .sort()
    .map((k) => `${k}: ${JSON.stringify(a[k])}`)
    .join('\n');
}

/**
 * Texts compared on the Review tab. A never-pinned tool has nothing to compare against, so the
 * old side is empty (every line shows as added) rather than `{}` (which read as "removed: {}").
 */
export function reviewTexts(diff: DefinitionDiff) {
  const pinned = diff.pinned;
  const words = wordDiff(pinned?.description ?? '', diff.current.description);
  const schemaOld = pinned ? stableStringify(pinned.inputSchema) : '';
  const schemaNew = stableStringify(diff.current.inputSchema);
  return { words, schemaOld, schemaNew, counts: lineDiff(schemaOld, schemaNew) };
}

function DiffBody({ diff, trusted, layout }: { diff: DefinitionDiff; trusted: boolean; layout: 'split' | 'unified' }) {
  const pinned = diff.pinned;
  const { words, schemaOld, schemaNew, counts } = useMemo(() => reviewTexts(diff), [diff]);
  return (
    <>
      <section className="flex flex-col gap-3 rounded-xl border bg-card p-4" aria-labelledby="d1">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 id="d1" className="text-[15px] font-semibold">1 · Description</h2>
          <span className="text-[13px] text-muted-foreground">word diff · changes here are read by the model as instructions</span>
        </div>
        <div className={layout === 'split' ? 'grid gap-3 lg:grid-cols-2' : 'flex flex-col gap-3'}>
          <div className="flex flex-col gap-1.5 rounded-lg border p-3" aria-label="Pinned description">
            <div className="flex items-center gap-2">
              <Pill tone="muted">Pinned</Pill>
              <span className="font-mono text-xs text-muted-foreground">{pinned ? shortHash(pinned.hash) : 'none · first review'}</span>
            </div>
            <WordDiffText parts={words} side="old" />
          </div>
          <div className="flex flex-col gap-1.5 rounded-lg border p-3" aria-label="New description">
            <div className="flex items-center gap-2">
              <Pill tone="warn">New</Pill>
              <span className="font-mono text-xs text-muted-foreground">{shortHash(diff.current.hash)}</span>
            </div>
            <WordDiffText parts={words} side="new" />
          </div>
        </div>
      </section>
      <section className="flex flex-col gap-3 rounded-xl border bg-card p-4" aria-labelledby="d2">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 id="d2" className="text-[15px] font-semibold">2 · Input schema</h2>
          <span className="text-[13px] text-muted-foreground">line diff · keys sorted so ordering changes aren't shown</span>
          <span className="flex-1" />
          <span className="font-mono text-xs text-success">+{counts.added}</span>
          <span className="font-mono text-xs text-destructive">−{counts.removed}</span>
        </div>
        <DiffView oldText={schemaOld} newText={schemaNew} layout={layout} />
      </section>
      <section className="flex flex-col gap-3 rounded-xl border bg-card p-4" aria-labelledby="d3">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 id="d3" className="text-[15px] font-semibold">3 · Annotations</h2>
          <span className="text-[13px] text-muted-foreground">reported by the server · {trusted ? 'trusted server' : 'untrusted (server not marked trusted)'}</span>
        </div>
        <DiffView oldText={annotationText(pinned?.annotations ?? null)} newText={annotationText(diff.current.annotations)} layout={layout} />
      </section>
    </>
  );
}

/**
 * Review tab (§5.2): what-changed chips, word diff of the description, sorted-key line diff of the
 * input schema, annotation diff; split ≥1024 px else unified (toggle). Approve binds to the exact
 * reviewed hash; a 409 means the definition changed again.
 */
export function ReviewPanel({ tool, canWrite }: { tool: ToolDetail; canWrite: boolean }) {
  const qc = useQueryClient();
  const wide = useMinWidth(1024);
  const [layout, setLayout] = useState<'split' | 'unified' | null>(null);
  const effective = layout ?? (wide ? 'split' : 'unified');
  const q = useQuery(definitionDiffQuery(tool.id));
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [stale, setStale] = useState(false);
  const done = (msg: string) => {
    notifySuccess(msg);
    void qc.invalidateQueries({ queryKey: toolKeys.all });
    void qc.invalidateQueries({ queryKey: authKeys.badges });
    // the server header and list show pending-review / enabled counts
    void qc.invalidateQueries({ queryKey: serverKeys.all });
  };
  const approve = useMutation({
    mutationFn: (hash: string) => apiFetch(api.tools.approveDefinition, { params: { id: tool.id }, body: { hash } }),
    onSuccess: () => {
      setApproving(false);
      done('New definition approved');
    },
    onError: (err) => {
      setApproving(false);
      if (err instanceof ApiError && err.status === 409) {
        setStale(true);
        void qc.invalidateQueries({ queryKey: toolKeys.diff(tool.id) });
      } else notifyError(err, 'Could not approve');
    },
  });
  const reject = useMutation({
    mutationFn: () => apiFetch(api.tools.rejectDefinition, { params: { id: tool.id }, body: note.trim() ? { note: note.trim() } : {} }),
    onSuccess: () => {
      setRejecting(false);
      done('Kept disabled');
    },
    onError: (err) => notifyError(err, 'Could not reject'),
  });
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data) return <Skeleton className="h-96 w-full" />;
  const diff = q.data;
  const chips = summarizeDefinitionChange(diff);
  return (
    <div className="flex flex-col gap-4">
      {stale ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/30 bg-warning-muted p-3 text-[13.5px] text-warning">
          The definition changed again since you opened it. Review the new diff below before approving.
          <Button size="sm" variant="outline" onClick={() => setStale(false)}>
            Reviewed
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-card p-3" aria-label="What changed">
        <span className="text-[13px] font-medium">What changed</span>
        {chips.map((c) => (
          <Pill key={c.label} tone={c.tone === 'danger' ? 'err' : 'warn'}>
            {c.label}
          </Pill>
        ))}
        <span className="flex-1" />
        <Segmented
          label="Diff layout"
          size="sm"
          value={effective}
          onChange={setLayout}
          options={[
            { value: 'split', label: 'Split' },
            { value: 'unified', label: 'Unified' },
          ]}
        />
      </div>
      <DiffBody diff={diff} trusted={tool.annotationsTrusted} layout={effective} />
      <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-4">
        <div className="flex min-w-72 flex-1 flex-col gap-1 text-[13.5px]">
          {diff.pinned ? (
            <span>
              Pinned <span className="font-mono text-[12.5px]">{shortHash(diff.pinned.hash)}</span>{' '}
              <span className="text-muted-foreground">by {diff.pinned.pinnedBy.name} · {formatDate(diff.pinned.pinnedAt)}</span>
            </span>
          ) : null}
          <span>
            Reviewing <span className="font-mono text-[12.5px]">{shortHash(diff.current.hash)}</span>{' '}
            <span className="text-muted-foreground">· approval binds to this exact hash; if it changes again you'll be asked to reload</span>
          </span>
        </div>
        {canWrite ? (
          <>
            <Button variant="outline" onClick={() => setRejecting(true)}>
              Keep disabled…
            </Button>
            <Button onClick={() => setApproving(true)}>Approve new definition…</Button>
          </>
        ) : null}
      </div>
      <ConfirmDialog
        open={approving}
        onOpenChange={setApproving}
        destructive={false}
        title="Approve this definition?"
        description="The tool can be enabled again and agents will see the new description and schema."
        confirmLabel="Approve definition"
        pending={approve.isPending}
        onConfirm={() => approve.mutate(diff.current.hash)}
      >
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
          <dt className="text-muted-foreground">Pinned</dt>
          <dd className="font-mono break-all">{diff.pinned?.hash ?? '—'}</dd>
          <dt className="text-muted-foreground">New</dt>
          <dd className="font-mono break-all">{diff.current.hash}</dd>
        </dl>
      </ConfirmDialog>
      <Dialog open={rejecting} onOpenChange={setRejecting}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Keep the tool disabled?</DialogTitle>
            <DialogDescription>The pinned definition stays; the tool stays blocked until a new definition is approved.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="reject-note">Note (optional)</Label>
            <Textarea id="reject-note" rows={3} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} placeholder="Why it was rejected, for the server owner" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejecting(false)}>
              Cancel
            </Button>
            <Button disabled={reject.isPending} onClick={() => reject.mutate()}>
              {reject.isPending ? <Spinner /> : null}
              Keep disabled
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
