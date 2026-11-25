import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type CreateGrantBody, type GrantEffect, type SubjectType } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { EntityPicker, type PickerOption } from '@/components/filters/entity-picker';
import { Segmented } from '@/components/filters/segmented';
import { ApiError, apiFetch } from '@/lib/api-client';
import { errorMessage, notifySuccess } from '@/lib/notify';
import { pickerSearch } from '../pickers';
import { grantKeys } from './queries';

export interface GrantDraft {
  subjectType: SubjectType;
  subject: PickerOption | null;
  server: PickerOption | null;
  tool: PickerOption | null;
  effect: GrantEffect;
  expiresOn: string;
}

/** Builds the POST /api/grants body; returns an error message instead when incomplete. */
export function grantBody(d: GrantDraft): { body: { subject: { type: SubjectType; id: string }; target: { type: 'server' | 'tool'; id: string }; effect: GrantEffect; expiresAt?: string } } | { error: string } {
  if (!d.subject) return { error: `Choose a ${d.subjectType}.` };
  if (!d.server) return { error: 'Choose a server.' };
  let expiresAt: string | undefined;
  if (d.expiresOn) {
    const t = Date.parse(`${d.expiresOn}T23:59:59.000Z`);
    if (Number.isNaN(t)) return { error: 'Invalid expiry date.' };
    expiresAt = new Date(t).toISOString();
  }
  return {
    body: {
      subject: { type: d.subjectType, id: d.subject.id },
      target: d.tool ? { type: 'tool', id: d.tool.id } : { type: 'server', id: d.server.id },
      effect: d.effect,
      ...(expiresAt ? { expiresAt } : {}),
    },
  };
}

const SUBJECT_SEARCH = { user: pickerSearch.users, group: pickerSearch.groups, agent: pickerSearch.agents };

/** "Add grant" (§5.2): subject type + subject, server → optional tool, Allow / Deny, optional expiry. */
export function AddGrantDialog({
  open,
  onOpenChange,
  initialServer,
  initialSubject,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initialServer?: PickerOption | null;
  /** Pre-filled subject (e.g. from a group page). */
  initialSubject?: { type: SubjectType; option: PickerOption };
}) {
  const qc = useQueryClient();
  const blank: GrantDraft = { subjectType: initialSubject?.type ?? 'group', subject: initialSubject?.option ?? null, server: initialServer ?? null, tool: null, effect: 'allow', expiresOn: '' };
  const [d, setD] = useState<GrantDraft>(blank);
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: CreateGrantBody) => apiFetch(api.grants.create, { body }),
    onSuccess: () => {
      notifySuccess('Grant added');
      void qc.invalidateQueries({ queryKey: grantKeys.all });
      setD(blank);
      onOpenChange(false);
    },
    onError: (err) => setError(err instanceof ApiError && err.status === 409 ? 'Grant already exists.' : errorMessage(err)),
  });
  const set = (p: Partial<GrantDraft>) => {
    setError(null);
    setD((x) => ({ ...x, ...p }));
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            const r = grantBody(d);
            if ('error' in r) return setError(r.error);
            create.mutate(r.body);
          }}
        >
          <DialogHeader>
            <DialogTitle>Add grant</DialogTitle>
            <DialogDescription>Grants are subject × server or tool × allow / deny. Deny always wins.</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel>Subject</FieldLabel>
            <div className="flex flex-wrap items-center gap-2">
              <Segmented<SubjectType>
                label="Subject type"
                size="sm"
                value={d.subjectType}
                onChange={(subjectType) => set({ subjectType, subject: null })}
                options={[
                  { value: 'group', label: 'Group' },
                  { value: 'user', label: 'User' },
                  { value: 'agent', label: 'Agent' },
                ]}
              />
              <EntityPicker label={`Choose ${d.subjectType}`} value={d.subject} onChange={(subject) => set({ subject })} search={SUBJECT_SEARCH[d.subjectType]} queryKey={[`${d.subjectType}s`]} />
            </div>
          </Field>
          <Field>
            <FieldLabel>Target</FieldLabel>
            <div className="flex flex-wrap items-center gap-2">
              <EntityPicker label="Server" value={d.server} onChange={(server) => set({ server, tool: null })} search={pickerSearch.servers} queryKey={['servers']} />
              <EntityPicker label="Tool" placeholder="All tools on this server" value={d.tool} disabled={!d.server} onChange={(tool) => set({ tool })} search={pickerSearch.tools(d.server?.id)} queryKey={['tools', d.server?.id ?? 'none']} />
            </div>
            <FieldDescription>Leave the tool empty to grant every tool on the server, including tools added later.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel>Effect</FieldLabel>
            <Segmented<GrantEffect>
              label="Effect"
              value={d.effect}
              onChange={(effect) => set({ effect })}
              options={[
                { value: 'allow', label: '✓ Allow' },
                { value: 'deny', label: '⛔ Deny' },
              ]}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="grant-expires">Expires (optional)</FieldLabel>
            <Input id="grant-expires" type="date" className="w-44" value={d.expiresOn} onChange={(e) => set({ expiresOn: e.target.value })} />
          </Field>
          {error ? <FieldError>{error}</FieldError> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? <Spinner /> : null}
              Add grant
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
