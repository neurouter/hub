import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, CreateAgentBody, type Agent } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Spinner } from '@/components/ui/spinner';
import { apiFetch, applyServerErrors } from '@/lib/api-client';
import { notifyError, notifySuccess } from '@/lib/notify';
import { agentKeys } from './queries';

/** CreateAgentBody with messages people can read (the shared schema has Zod's defaults). */
export const agentFormSchema = CreateAgentBody.extend({
  name: z.string().trim().min(1, 'Give the agent a name.').max(100, 'Use 100 characters or fewer.'),
  description: z.string().max(1000, 'Use 1000 characters or fewer.').optional(),
});

/**
 * New / edit agent (§5.1). Phase 1 has no tool exposure mode (addendum #1): only name and
 * description; a duplicate name comes back as 409 and is shown on the name field.
 */
export function AgentFormDialog({ open, onOpenChange, agent, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; agent?: Agent; onSaved?: (a: Agent) => void }) {
  const qc = useQueryClient();
  const form = useForm<{ name: string; description?: string | undefined }>({
    resolver: zodResolver(agentFormSchema),
    defaultValues: { name: agent?.name ?? '', description: agent?.description ?? '' },
  });
  useEffect(() => {
    if (open) form.reset({ name: agent?.name ?? '', description: agent?.description ?? '' });
  }, [open, agent, form]);
  const save = useMutation({
    mutationFn: (body: { name: string; description?: string | undefined }) =>
      agent ? apiFetch(api.agents.update, { params: { id: agent.id }, body }) : apiFetch(api.agents.create, { body }),
    onSuccess: (a) => {
      void qc.invalidateQueries({ queryKey: agentKeys.all });
      notifySuccess(agent ? 'Agent saved' : `Agent “${a.name}” created`);
      onOpenChange(false);
      onSaved?.(a);
    },
    onError: (err) => {
      if (applyServerErrors(form, err)) return;
      if ((err as { status?: number }).status === 409) form.setError('name', { type: 'server', message: 'You already have an agent with this name.' });
      else notifyError(err, 'Could not save the agent');
    },
  });
  const { errors } = form.formState;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={form.handleSubmit((v) => save.mutate({ name: v.name, ...(v.description ? { description: v.description } : {}) }))} className="contents" noValidate>
          <DialogHeader>
            <DialogTitle>{agent ? 'Edit agent' : 'New agent'}</DialogTitle>
            <DialogDescription>Agents act with your grants, optionally narrowed. Audit records “agent on behalf of you”.</DialogDescription>
          </DialogHeader>
          <Field data-invalid={!!errors.name}>
            <FieldLabel htmlFor="agent-name">Name</FieldLabel>
            <Input id="agent-name" aria-invalid={!!errors.name} autoComplete="off" {...form.register('name')} placeholder="release-bot" />
            <FieldError errors={[errors.name]} />
          </Field>
          <Field data-invalid={!!errors.description}>
            <FieldLabel htmlFor="agent-description">Description</FieldLabel>
            <Textarea id="agent-description" rows={3} {...form.register('description')} placeholder="What it does and where it runs" />
            <FieldDescription>Optional. Shown to reviewers on approval requests.</FieldDescription>
            <FieldError errors={[errors.description]} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? <Spinner /> : null}
              {agent ? 'Save' : 'Create agent'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
