import { useState } from 'react';
import type { AccessRequest, ApproveAccessRequestBody } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { EntityPicker, type PickerOption } from '@/components/filters/entity-picker';
import { Segmented } from '@/components/filters/segmented';
import { pickerSearch } from '@/features/pickers';

type GrantTo = 'user' | 'agent' | 'group';

/** Builds the approve body (§5.2): grant subject, optional narrowing server → tool, expiry, note. */
export function approveBody(r: AccessRequest, o: { grantTo: GrantTo; group: PickerOption | null; tool: PickerOption | null; expiresOn: string; note: string }): ApproveAccessRequestBody {
  const subject = o.grantTo === 'agent' && r.agent ? { type: 'agent' as const, id: r.agent.id } : o.grantTo === 'group' && o.group ? { type: 'group' as const, id: o.group.id } : { type: 'user' as const, id: r.requester.id };
  return {
    grantSubject: subject,
    ...(o.tool && r.target.type === 'server' ? { target: { type: 'tool' as const, id: o.tool.id } } : {}),
    ...(o.expiresOn ? { expiresAt: new Date(`${o.expiresOn}T23:59:59.000Z`).toISOString() } : {}),
    ...(o.note.trim() ? { note: o.note.trim() } : {}),
  };
}

export function ApproveDialog({ request, onClose, onApprove, pending }: { request: AccessRequest | null; onClose: () => void; onApprove: (r: AccessRequest, body: ApproveAccessRequestBody) => void; pending: boolean }) {
  const [grantTo, setGrantTo] = useState<GrantTo>('user');
  const [group, setGroup] = useState<PickerOption | null>(null);
  const [tool, setTool] = useState<PickerOption | null>(null);
  const [expiresOn, setExpiresOn] = useState('');
  const [note, setNote] = useState('');
  const r = request;
  return (
    <Dialog open={!!r} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        {r ? (
          <form
            className="contents"
            onSubmit={(e) => {
              e.preventDefault();
              if (grantTo === 'group' && !group) return;
              onApprove(r, approveBody(r, { grantTo, group, tool, expiresOn, note }));
            }}
          >
            <DialogHeader>
              <DialogTitle>Approve access to {r.target.name}</DialogTitle>
              <DialogDescription>Creates an allow grant. Deny grants still win.</DialogDescription>
            </DialogHeader>
            <p className="rounded-lg bg-muted p-3 text-[13.5px]">“{r.reason}” · {r.requester.name}</p>
            <Field>
              <FieldLabel>Grant to</FieldLabel>
              <Segmented<GrantTo>
                label="Grant to"
                size="sm"
                value={grantTo}
                onChange={setGrantTo}
                options={[{ value: 'user', label: r.requester.name }, ...(r.agent ? [{ value: 'agent' as const, label: `Agent ${r.agent.name}` }] : []), { value: 'group', label: 'A group' }]}
              />
              {grantTo === 'group' ? <EntityPicker label="Group" value={group} onChange={setGroup} search={pickerSearch.groups} queryKey={['groups']} /> : null}
              {grantTo === 'group' && !group ? <FieldDescription>Pick one of the requester's groups.</FieldDescription> : null}
            </Field>
            {r.target.type === 'server' ? (
              <Field>
                <FieldLabel>Scope</FieldLabel>
                <EntityPicker label="Tool" placeholder={`All tools on ${r.target.server.name} (as requested)`} value={tool} onChange={setTool} search={pickerSearch.tools(r.target.server.id)} queryKey={['tools', r.target.server.id]} />
                <FieldDescription>Optionally narrow the grant to one tool.</FieldDescription>
              </Field>
            ) : null}
            <Field>
              <FieldLabel htmlFor="appr-exp">Expires (optional)</FieldLabel>
              <Input id="appr-exp" type="date" className="w-44" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="appr-note">Note (optional)</FieldLabel>
              <Textarea id="appr-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending || (grantTo === 'group' && !group)}>
                Approve
              </Button>
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function DenyDialog({ request, onClose, onDeny, pending }: { request: AccessRequest | null; onClose: () => void; onDeny: (r: AccessRequest, note: string) => void; pending: boolean }) {
  const [note, setNote] = useState('');
  const [touched, setTouched] = useState(false);
  const invalid = !note.trim();
  return (
    <Dialog open={!!request} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (request && !invalid) onDeny(request, note.trim());
          }}
        >
          <DialogHeader>
            <DialogTitle>Deny access to {request?.target.name}</DialogTitle>
            <DialogDescription>The requester sees your note.</DialogDescription>
          </DialogHeader>
          <Field data-invalid={touched && invalid}>
            <FieldLabel htmlFor="deny-note">Note</FieldLabel>
            <Textarea id="deny-note" rows={3} aria-invalid={touched && invalid} value={note} onChange={(e) => setNote(e.target.value)} />
            {touched && invalid ? <FieldError>A note is required when denying.</FieldError> : null}
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={pending}>
              Deny request
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

