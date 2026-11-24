import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { api, type Role } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { apiFetch, applyServerErrors } from '@/lib/api-client';
import { notifyError, notifySuccess } from '@/lib/notify';
import { userKeys } from './queries';

const schema = z.object({ email: z.email('Enter a valid email address').max(320), name: z.string().trim().max(200) });
type Form = z.infer<typeof schema>;

/** Body for POST /api/users: empty name and no roles are left out (the server derives the name from the IdP at first sign-in). */
export function createUserBody(v: Form, roles: readonly Role[]) {
  return { email: v.email.trim(), ...(v.name.trim() ? { name: v.name.trim() } : {}), ...(roles.length ? { roles: [...roles] } : {}) };
}

/**
 * Pre-provision a user (admin): the account exists before first sign-in so grants and roles can be
 * set up ahead of time; the identity provider still authenticates them.
 */
export function AddUserDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [roles, setRoles] = useState<Role[]>([]);
  const form = useForm<Form>({ resolver: zodResolver(schema), defaultValues: { email: '', name: '' } });
  const create = useMutation({
    mutationFn: (v: Form) => apiFetch(api.users.create, { body: createUserBody(v, roles) }),
    onSuccess: (u) => {
      notifySuccess(`${u.name} added`);
      void qc.invalidateQueries({ queryKey: userKeys.all });
      onOpenChange(false);
      form.reset();
      setRoles([]);
      void navigate({ to: '/admin/users/$userId', params: { userId: u.id } });
    },
    onError: (err) => {
      if (!applyServerErrors(form, err)) notifyError(err, 'Could not add the user');
    },
  });
  const toggle = (r: Role, on: boolean) => setRoles((cur) => (on ? [...new Set([...cur, r])] : cur.filter((x) => x !== r)));
  const { errors } = form.formState;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form className="contents" noValidate onSubmit={form.handleSubmit((v) => create.mutate(v))}>
          <DialogHeader>
            <DialogTitle>Add user</DialogTitle>
            <DialogDescription>Set up access before their first sign-in. They still sign in through your identity provider with this email.</DialogDescription>
          </DialogHeader>
          <Field data-invalid={!!errors.email}>
            <FieldLabel htmlFor="user-email">Email</FieldLabel>
            <Input id="user-email" type="email" autoComplete="off" aria-invalid={!!errors.email} {...form.register('email')} />
            <FieldError errors={[errors.email]} />
          </Field>
          <Field data-invalid={!!errors.name}>
            <FieldLabel htmlFor="user-name">Name (optional)</FieldLabel>
            <Input id="user-name" autoComplete="off" {...form.register('name')} />
            <FieldDescription>Replaced by the name from the identity provider at first sign-in.</FieldDescription>
            <FieldError errors={[errors.name]} />
          </Field>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-[13.5px] font-medium">Roles</legend>
            {(['admin', 'auditor'] as const).map((r) => (
              <label key={r} className="flex items-start gap-2.5 text-[13.5px]">
                <Checkbox checked={roles.includes(r)} onCheckedChange={(v) => toggle(r, Boolean(v))} aria-label={r === 'admin' ? 'Admin' : 'Auditor'} className="mt-0.5" />
                <span className="flex flex-col">
                  <span className="font-medium">{r === 'admin' ? 'Admin' : 'Auditor'}</span>
                  <span className="text-muted-foreground">{r === 'admin' ? 'Full control of the gateway.' : 'Read-only access to everything, including the audit log.'}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? <Spinner /> : null}
              Add user
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
