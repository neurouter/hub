import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Approval } from '@neurouter/shared';
import { authKeys } from '@/features/auth/queries';
import { ApiError, apiFetch } from '@/lib/api-client';
import { notifyError, notifySuccess } from '@/lib/notify';
import { toast } from '@/components/ui/toast';
import { approvalKeys, removeApproval, type ApprovalPage } from './model';

export const POLL_MS = 5000;

export function pendingApprovalsQuery(f: { limit?: number; mine?: boolean } = { limit: 200 }) {
  return queryOptions({
    queryKey: approvalKeys.list('pending', f),
    queryFn: ({ signal }) => apiFetch(api.approvals.list, { query: { status: 'pending', ...f }, signal }),
    staleTime: 0,
  });
}

export function approvalQuery(id: string) {
  return queryOptions({ queryKey: [...approvalKeys.all, 'detail', id] as const, queryFn: ({ signal }) => apiFetch(api.approvals.get, { params: { id }, signal }), staleTime: 0, retry: false });
}

export function resolvedApprovalsQuery(f: { limit?: number; mine?: boolean } = { limit: 50 }) {
  return queryOptions({
    queryKey: approvalKeys.list('resolved', f),
    queryFn: ({ signal }) => apiFetch(api.approvals.list, { query: { status: 'resolved', ...f }, signal }),
    staleTime: 30_000,
  });
}

export type Decision = { approval: Approval; decision: 'approve' } | { approval: Approval; decision: 'deny'; reason: string };

/**
 * Approve / deny with optimistic removal (§6.2). 409 (already resolved) and 410 (expired) keep the
 * card removed and say why; other errors put it back.
 */
export function useDecideApproval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (d: Decision) =>
      d.decision === 'approve'
        ? apiFetch(api.approvals.approve, { params: { id: d.approval.id }, body: {} })
        : apiFetch(api.approvals.deny, { params: { id: d.approval.id }, body: { reason: d.reason } }),
    onMutate: async (d) => {
      await qc.cancelQueries({ queryKey: approvalKeys.status('pending') });
      const snapshot = qc.getQueriesData<ApprovalPage>({ queryKey: approvalKeys.status('pending') });
      qc.setQueriesData<ApprovalPage>({ queryKey: approvalKeys.status('pending') }, (p) => removeApproval(p, d.approval.id));
      return { snapshot };
    },
    onSuccess: (_res, d) => {
      const tool = d.approval.tool.qualifiedName;
      if (d.decision === 'approve') notifySuccess(`Approved ${tool}`, `The held call is proceeding for ${d.approval.agent.name}.`);
      else toast.add({ title: `Denied ${tool}`, description: 'The agent receives an error result with your reason.', type: 'info' });
    },
    onError: (err, _d, ctx) => {
      if (err instanceof ApiError && (err.status === 409 || err.status === 410)) {
        toast.add({
          title: err.status === 410 ? 'This approval expired' : 'Already handled',
          description: err.detail ?? (err.status === 410 ? 'The agent received a timeout error.' : 'Someone else decided on this call first.'),
          type: 'info',
        });
        return;
      }
      for (const [key, data] of ctx?.snapshot ?? []) qc.setQueryData(key, data);
      notifyError(err, 'Could not record the decision');
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: approvalKeys.lists() });
      void qc.invalidateQueries({ queryKey: authKeys.badges });
    },
  });
}
