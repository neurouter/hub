import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Pill } from '@/components/status/status';
import { authKeys } from '@/features/auth/queries';
import { serverKeys } from '@/features/servers/queries';
import { apiFetch } from '@/lib/api-client';
import { notifyError, notifySuccess } from '@/lib/notify';
import { summarizeDefinitionChange } from './definition-change';
import { definitionDiffQuery, toolKeys, toolsListQuery } from './queries';

/**
 * Review every pending definition of one server in one place (e.g. after a sync that changed 20
 * descriptions). Each row shows what changed; approving sends the exact hashes shown, so a tool
 * that changed again meanwhile is reported back instead of approved.
 */
export function BulkReviewDialog({ serverId, open, onOpenChange }: { serverId: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const pending = useQuery({ ...toolsListQuery({ serverId: [serverId], status: 'pending_review', limit: 200 }), enabled: open });
  const tools = useMemo(() => pending.data?.items ?? [], [pending.data]);
  const diffs = useQueries({ queries: tools.map((t) => ({ ...definitionDiffQuery(t.id), enabled: open })) });
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  const rows = tools.map((t, i) => {
    const d = diffs[i]?.data;
    return { tool: t, hash: d?.current.hash ?? null, chips: d ? summarizeDefinitionChange(d) : null, isNew: d ? d.pinned === null : false };
  });
  const selected = rows.filter((r) => r.hash && !excluded.has(r.tool.id));
  const loading = pending.isLoading || diffs.some((d) => d.isLoading);

  const approve = useMutation({
    mutationFn: () => apiFetch(api.tools.approveDefinitions, { body: { items: selected.map((r) => ({ id: r.tool.id, hash: r.hash! })) } }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: toolKeys.all });
      void qc.invalidateQueries({ queryKey: serverKeys.detail(serverId) });
      void qc.invalidateQueries({ queryKey: authKeys.badges });
      if (res.failed.length) {
        notifyError(new Error(res.failed.map((f) => `${tools.find((t) => t.id === f.id)?.qualifiedName ?? f.id}: ${f.reason}`).join('\n')), `Approved ${res.approved.length}; ${res.failed.length} not approved`);
      } else {
        notifySuccess(`Approved ${res.approved.length} definition${res.approved.length === 1 ? '' : 's'}`);
        onOpenChange(false);
      }
      setExcluded(new Set());
    },
    onError: (err) => notifyError(err, 'Could not approve the definitions'),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Review pending definitions</DialogTitle>
          <DialogDescription>
            New and changed tools on this server stay blocked until approved. Open a tool to read its full diff; approving here pins exactly the versions listed.
          </DialogDescription>
        </DialogHeader>
        <ul className="flex max-h-[55vh] flex-col divide-y overflow-y-auto rounded-lg border" aria-label="Pending definitions">
          {loading && !rows.length ? (
            <li className="p-3">
              <Skeleton className="h-10 w-full" />
            </li>
          ) : null}
          {!loading && !rows.length ? <li className="p-4 text-[13.5px] text-muted-foreground">Nothing is waiting for review.</li> : null}
          {rows.map((r) => {
            const id = `bulk-${r.tool.id}`;
            return (
              <li key={r.tool.id} className="flex items-start gap-3 p-3">
                <Checkbox
                  id={id}
                  className="mt-0.5"
                  checked={!excluded.has(r.tool.id)}
                  disabled={!r.hash}
                  onCheckedChange={(v) =>
                    setExcluded((prev) => {
                      const next = new Set(prev);
                      if (v) next.delete(r.tool.id);
                      else next.add(r.tool.id);
                      return next;
                    })
                  }
                  aria-label={`Include ${r.tool.qualifiedName}`}
                />
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <Link
                    to="/admin/tools/$toolId"
                    params={{ toolId: r.tool.id }}
                    search={{ tab: 'review' }}
                    className="font-mono text-[12.5px] font-medium break-all underline-offset-4 hover:underline"
                  >
                    {r.tool.qualifiedName}
                  </Link>
                  <div className="flex flex-wrap gap-1.5">
                    {r.chips === null ? <Skeleton className="h-5 w-40" /> : null}
                    {r.isNew ? <Pill tone="info">New tool</Pill> : null}
                    {r.chips?.map((c) => (
                      <Pill key={c.label} tone={c.tone === 'danger' ? 'err' : 'warn'}>
                        {c.label}
                      </Pill>
                    ))}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button disabled={!selected.length || approve.isPending || loading} onClick={() => approve.mutate()}>
            {approve.isPending ? <Spinner /> : null} Approve {selected.length} selected
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
