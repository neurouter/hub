import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as z from 'zod';
import { api, type Settings } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Section } from '@/components/layout/section';
import { apiFetch, applyServerErrors } from '@/lib/api-client';
import { notifyError, notifySuccess } from '@/lib/notify';
import { NumberField } from './general-tab';
import { settingsKeys } from './queries';
import { UnsavedHint, useUnsavedGuard } from './unsaved-guard';

const n = z.coerce.number<string | number>().int().min(1).max(100_000);
const schema = z.object({ agentPerMinute: n, agentBurst: n, toolPerMinute: n, toolBurst: n });
type Form = z.input<typeof schema>;

/** Rate limits (W4): default per-agent and per-tool token buckets. Tool overrides live on each tool's Policy tab. */
export function RateLimitsTab({ settings, readOnly }: { settings: Settings; readOnly: boolean }) {
  const qc = useQueryClient();
  const defaults = (s: Settings): Form => ({ agentPerMinute: s.rateLimits.agent.perMinute, agentBurst: s.rateLimits.agent.burst, toolPerMinute: s.rateLimits.tool.perMinute, toolBurst: s.rateLimits.tool.burst });
  const form = useForm<Form, unknown, z.output<typeof schema>>({ resolver: zodResolver(schema), defaultValues: defaults(settings) });
  useEffect(() => form.reset(defaults(settings)), [settings, form]);
  useUnsavedGuard(form.formState.isDirty);
  const save = useMutation({
    mutationFn: (v: z.output<typeof schema>) =>
      apiFetch(api.settings.update, { body: { rateLimits: { agent: { perMinute: v.agentPerMinute, burst: v.agentBurst }, tool: { perMinute: v.toolPerMinute, burst: v.toolBurst } } } }),
    onSuccess: (s) => {
      qc.setQueryData(settingsKeys.all, s);
      form.reset(defaults(s));
      notifySuccess('Saved');
    },
    onError: (err) => {
      if (!applyServerErrors(form, err)) notifyError(err, 'Could not save rate limits');
    },
  });
  const e = form.formState.errors;
  return (
    <form noValidate onSubmit={form.handleSubmit((v) => save.mutate(v))} className="flex flex-col gap-5">
      <Section title="Per agent" description="Token bucket per agent across all tools: a sustained rate per minute plus a burst allowance.">
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField id="agent-rpm" label="Requests per minute" disabled={readOnly} error={e.agentPerMinute} {...form.register('agentPerMinute')} />
          <NumberField id="agent-burst" label="Burst" disabled={readOnly} error={e.agentBurst} {...form.register('agentBurst')} />
        </div>
      </Section>
      <Section title="Per tool (default)" description="Applies to each tool unless the tool's Policy tab sets an override.">
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField id="tool-rpm" label="Requests per minute" disabled={readOnly} error={e.toolPerMinute} {...form.register('toolPerMinute')} />
          <NumberField id="tool-burst" label="Burst" disabled={readOnly} error={e.toolBurst} {...form.register('toolBurst')} />
        </div>
      </Section>
      {!readOnly ? (
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={!form.formState.isDirty || save.isPending}>
            {save.isPending ? <Spinner /> : null}
            Save
          </Button>
          <UnsavedHint dirty={form.formState.isDirty} />
        </div>
      ) : null}
    </form>
  );
}
