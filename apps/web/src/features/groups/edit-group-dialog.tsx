import { useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { api, CreateGroupBody, type GroupRow, type UpdateGroupBody } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { apiFetch, applyServerErrors } from '@/lib/api-client';
import { notifyError, notifySuccess } from '@/lib/notify';
import { groupKeys } from './queries';

type Form = { name: string; description?: string | undefined };

/** Only the fields that changed (PATCH /api/groups/:id); IdP groups keep their name. */
export function groupPatch(g: Pick<GroupRow, 'name' | 'description' | 'source'>, v: Form): UpdateGroupBody {
  const out: UpdateGroupBody = {};
  if (g.source === 'local' && v.name.trim() !== g.name) out.name = v.name.trim();
  const d = v.description ?? '';
  if (d !== g.description) out.description = d;
  return out;
}

/** Edit a group's name (local groups) and description (any group). */
export function EditGroupDialog({ group, open, onOpenChange }: { group: GroupRow; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const form = useForm<Form>({ resolver: zodResolver(CreateGroupBody), defaultValues: { name: group.name, description: group.description } });
  useEffect(() => {
    if (open) form.reset({ name: group.name, description: group.description });
  }, [open, group, form]);
  const save = useMutation({
    mutationFn: (body: UpdateGroupBody) => apiFetch(api.groups.update, { params: { id: group.id }, body }),
    onSuccess: (g) => {
      notifySuccess(`Group “${g.name}” saved`);
      void qc.invalidateQueries({ queryKey: groupKeys.all });
      onOpenChange(false);
    },
    onError: (err) => {
      if (!applyServerErrors(form, err)) notifyError(err, 'Could not save the group');
    },
  });
  const { errors } = form.formState;
  const idp = group.source === 'oidc';
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form
          className="contents"
          noValidate
          onSubmit={form.handleSubmit((v) => {
            const body = groupPatch(group, v);
            if (!Object.keys(body).length) onOpenChange(false);
            else save.mutate(body);
          })}
        >
          <DialogHeader>
            <DialogTitle>Edit group</DialogTitle>
            <DialogDescription>{idp ? 'The name comes from your identity provider; you can add a description.' : 'Changes are recorded in the audit log.'}</DialogDescription>
          </DialogHeader>
          <Field data-invalid={!!errors.name}>
            <FieldLabel htmlFor="edit-group-name">Name</FieldLabel>
            <Input id="edit-group-name" disabled={idp} aria-invalid={!!errors.name} {...form.register('name')} />
            {idp ? <FieldDescription>Set by the identity provider.</FieldDescription> : null}
            <FieldError errors={[errors.name]} />
          </Field>
          <Field data-invalid={!!errors.description}>
            <FieldLabel htmlFor="edit-group-description">Description</FieldLabel>
            <Textarea id="edit-group-description" rows={3} {...form.register('description')} />
            <FieldError errors={[errors.description]} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? <Spinner /> : null}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
