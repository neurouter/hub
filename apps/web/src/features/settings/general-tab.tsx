import { useEffect } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as z from 'zod';
import { api, type Settings } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Section } from '@/components/layout/section';
import { apiFetch, applyServerErrors } from '@/lib/api-client';
import { notifyError, notifySuccess } from '@/lib/notify';
import { settingsKeys } from './queries';
import { UnsavedHint, useUnsavedGuard } from './unsaved-guard';

const int = (min: number, max: number) => z.coerce.number<string | number>().int().min(min).max(max);
const schema = z.object({
  auditDays: int(1, 3650),
  metricsDays: int(1, 3650),
  storeFullOutput: z.boolean(),
  approvalTimeoutMinutes: int(1, 60),
  idleMinutes: int(1, 1440),
});
type Form = z.input<typeof schema>;

function NumberField({ id, label, hint, error, disabled, ...rest }: { id: string; label: string; hint?: string; error?: { message?: string } | undefined; disabled: boolean } & React.ComponentProps<'input'>) {
  return (
    <Field data-invalid={!!error} className="max-w-xs">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input id={id} type="number" inputMode="numeric" aria-invalid={!!error} disabled={disabled} {...rest} />
      {hint ? <FieldDescription>{hint}</FieldDescription> : null}
      <FieldError errors={[error]} />
    </Field>
  );
}
export { NumberField };

/** General: retention, approval timeout, session idle gap. PATCH /api/settings (partial). */
export function GeneralTab({ settings, readOnly }: { settings: Settings; readOnly: boolean }) {
  const qc = useQueryClient();
  const defaults = (s: Settings): Form => ({
    auditDays: s.retention.auditDays,
    metricsDays: s.retention.metricsDays,
    storeFullOutput: s.retention.storeFullOutput,
    approvalTimeoutMinutes: s.approvals.timeoutMinutes,
    idleMinutes: s.sessions.idleMinutes,
  });
  const form = useForm<Form, unknown, z.output<typeof schema>>({ resolver: zodResolver(schema), defaultValues: defaults(settings) });
  useEffect(() => form.reset(defaults(settings)), [settings, form]);
  useUnsavedGuard(form.formState.isDirty);
  const save = useMutation({
    mutationFn: (v: z.output<typeof schema>) =>
      apiFetch(api.settings.update, {
        body: {
          retention: { auditDays: v.auditDays, metricsDays: v.metricsDays, storeFullOutput: v.storeFullOutput },
          approvals: { timeoutMinutes: v.approvalTimeoutMinutes },
          sessions: { idleMinutes: v.idleMinutes },
        },
      }),
    onSuccess: (s) => {
      qc.setQueryData(settingsKeys.all, s);
      form.reset(defaults(s));
      notifySuccess('Saved');
    },
    onError: (err) => {
      if (!applyServerErrors(form, err)) notifyError(err, 'Could not save settings');
    },
  });
  const e = form.formState.errors;
  return (
    <form noValidate onSubmit={form.handleSubmit((v) => save.mutate(v))} className="flex flex-col gap-5">
      <Section title="Retention" description="How long the audit log and metrics rollups are kept.">
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField id="audit-days" label="Audit log (days)" disabled={readOnly} error={e.auditDays} {...form.register('auditDays')} />
          <NumberField id="metrics-days" label="Metrics rollups (days)" disabled={readOnly} error={e.metricsDays} {...form.register('metricsDays')} />
        </div>
        <Controller
          control={form.control}
          name="storeFullOutput"
          render={({ field }) => (
            <label className="mt-4 flex items-start gap-3">
              <Switch checked={field.value} onCheckedChange={field.onChange} disabled={readOnly} className="mt-0.5" />
              <span className="flex flex-col">
                <span className="font-medium">Store full tool output</span>
                <span className="text-[13px] text-muted-foreground">Off: outputs are recorded as size + SHA-256 only (recommended).</span>
              </span>
            </label>
          )}
        />
      </Section>
      <Section title="Approvals and sessions">
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField id="approval-timeout" label="Approval timeout (minutes)" hint="Held calls are denied when nobody decides in time." disabled={readOnly} error={e.approvalTimeoutMinutes} {...form.register('approvalTimeoutMinutes')} />
          <NumberField id="idle-minutes" label="Session idle gap (minutes)" hint="Calls further apart start a new inferred session." disabled={readOnly} error={e.idleMinutes} {...form.register('idleMinutes')} />
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
