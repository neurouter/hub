import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ACCESS_REQUEST_REASON_MAX, ACCESS_REQUEST_REASON_MIN, api, type TargetType } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { authKeys } from '@/features/auth/queries';
import { catalogKeys } from '@/features/catalog/queries';
import { agentsListQuery } from '@/features/agents/queries';
import { ApiError, apiFetch } from '@/lib/api-client';
import { errorMessage, notifySuccess } from '@/lib/notify';
import { requestKeys } from './queries';

/** UI limit for the reason (the prototype says 10–500; the API accepts up to 1000). */
export const REASON_UI_MAX = Math.min(500, ACCESS_REQUEST_REASON_MAX);

export function reasonError(reason: string): string | null {
  const n = reason.trim().length;
  if (n < ACCESS_REQUEST_REASON_MIN) return `Tell the reviewer why (at least ${ACCESS_REQUEST_REASON_MIN} characters).`;
  if (n > REASON_UI_MAX) return `Keep it under ${REASON_UI_MAX} characters.`;
  return null;
}

export interface RequestTarget {
  type: TargetType;
  id: string;
  name: string;
  ownerName?: string;
}

/**
 * Request access (§5.1): target fixed, reason required (10–500 chars), optional "for agent".
 * POST /api/access-requests; afterwards the catalog shows "Requested" and a toast.
 */
export function RequestAccessDialog({ target, onOpenChange }: { target: RequestTarget | null; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [agentId, setAgentId] = useState<string>('none');
  const [touched, setTouched] = useState(false);
  const agents = useQuery({ ...agentsListQuery({ owner: 'me', limit: 200 }), enabled: !!target });
  const create = useMutation({
    mutationFn: () => apiFetch(api.accessRequests.create, { body: { target: { type: target!.type, id: target!.id }, reason: reason.trim(), ...(agentId !== 'none' ? { agentId } : {}) } }),
    onSuccess: () => {
      notifySuccess('Access requested', `Reviewers will see your request for ${target?.name}.`);
      void qc.invalidateQueries({ queryKey: catalogKeys.all });
      void qc.invalidateQueries({ queryKey: requestKeys.all });
      void qc.invalidateQueries({ queryKey: authKeys.badges });
      setReason('');
      setTouched(false);
      onOpenChange(false);
    },
  });
  const err = reasonError(reason);
  const items = [{ value: 'none', label: 'Me (no specific agent)' }, ...(agents.data?.items ?? []).map((a) => ({ value: a.id, label: a.name }))];
  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form
          className="contents"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (!err) create.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Request access to {target?.name}</DialogTitle>
            <DialogDescription>
              Reviewers: {target?.ownerName ? `${target.ownerName} (server owner) and ` : ''}Admins. Approval creates a grant for you or the selected agent.
            </DialogDescription>
          </DialogHeader>
          <Field data-invalid={touched && !!err}>
            <FieldLabel htmlFor="ar-reason">
              Reason <span className="font-normal text-muted-foreground">(required, {ACCESS_REQUEST_REASON_MIN}–{REASON_UI_MAX} characters)</span>
            </FieldLabel>
            <Textarea id="ar-reason" rows={4} aria-invalid={touched && !!err} value={reason} onChange={(e) => setReason(e.target.value)} />
            <FieldDescription className="text-right tabular-nums">
              {reason.trim().length} / {REASON_UI_MAX}
            </FieldDescription>
            {touched && err ? <FieldError>{err}</FieldError> : null}
          </Field>
          <Field>
            <FieldLabel htmlFor="ar-agent">
              For agent <span className="font-normal text-muted-foreground">(optional)</span>
            </FieldLabel>
            <Select value={agentId} onValueChange={(v) => setAgentId(String(v))} items={items}>
              <SelectTrigger id="ar-agent" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {items.map((i) => (
                  <SelectItem key={i.value} value={i.value}>
                    {i.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {create.error ? (
            <FieldError>{create.error instanceof ApiError && create.error.status === 409 ? 'You already have a pending request for this.' : errorMessage(create.error)}</FieldError>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? <Spinner /> : null}
              Send request
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
