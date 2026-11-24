import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as z from 'zod';
import { CheckIcon, LockIcon, XIcon } from 'lucide-react';
import { api, type ExportTestResult, type Settings, type UpdateSettingsBody } from '@neurouter/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { DetailList, Section } from '@/components/layout/section';
import { Pill } from '@/components/status/status';
import { apiFetch, applyServerErrors } from '@/lib/api-client';
import { notifyError, notifySuccess } from '@/lib/notify';
import { settingsKeys } from './queries';
import { UnsavedHint, useUnsavedGuard } from './unsaved-guard';

const schema = z
  .object({
    webhookUrl: z.string().trim().max(2048),
    webhookEnabled: z.boolean(),
    otlpLogsEnabled: z.boolean(),
    /** write-only: empty = keep the current secret */
    webhookSecret: z.string().max(512),
  })
  .superRefine((v, ctx) => {
    if (v.webhookUrl && !/^https?:\/\/\S+$/i.test(v.webhookUrl)) ctx.addIssue({ code: 'custom', path: ['webhookUrl'], message: 'Enter an http(s) URL' });
    if (v.webhookEnabled && !v.webhookUrl) ctx.addIssue({ code: 'custom', path: ['webhookUrl'], message: 'A URL is required to enable the webhook' });
    if (v.webhookSecret && v.webhookSecret.length < 16) ctx.addIssue({ code: 'custom', path: ['webhookSecret'], message: 'Use at least 16 characters' });
  });
type Form = z.infer<typeof schema>;

/** PATCH body for the export section: only changed fields; the secret only when replaced. */
export function exportPatch(v: Form, current: Settings['export']): UpdateSettingsBody {
  const e: NonNullable<UpdateSettingsBody['export']> = {};
  const url = v.webhookUrl || null;
  if (url !== current.webhookUrl) e.webhookUrl = url;
  if (v.webhookEnabled !== current.webhookEnabled) e.webhookEnabled = v.webhookEnabled;
  if (v.otlpLogsEnabled !== current.otlpLogsEnabled) e.otlpLogsEnabled = v.otlpLogsEnabled;
  if (v.webhookSecret) e.webhookSecret = v.webhookSecret;
  return { export: e };
}

/**
 * Settings → Export (§5.2, optional Phase 1): audit webhook URL + write-only signing secret +
 * "Send test event", OTLP log export. Env-sourced config is shown read-only.
 */
export function ExportTab({ settings, readOnly: roleReadOnly }: { settings: Settings; readOnly: boolean }) {
  const qc = useQueryClient();
  const ex = settings.export;
  const envSourced = ex.source === 'env';
  const readOnly = roleReadOnly || envSourced;
  const defaults = (s: Settings['export']): Form => ({ webhookUrl: s.webhookUrl ?? '', webhookEnabled: s.webhookEnabled, otlpLogsEnabled: s.otlpLogsEnabled, webhookSecret: '' });
  const form = useForm<Form>({ resolver: zodResolver(schema), defaultValues: defaults(ex) });
  const [replacing, setReplacing] = useState(false);
  const [test, setTest] = useState<ExportTestResult | null>(null);
  useEffect(() => form.reset(defaults(ex)), [ex, form]);
  useUnsavedGuard(form.formState.isDirty);
  const save = useMutation({
    mutationFn: (v: Form) => apiFetch(api.settings.update, { body: exportPatch(v, ex) }),
    onSuccess: (s) => {
      qc.setQueryData(settingsKeys.all, s);
      form.reset(defaults(s.export));
      setReplacing(false);
      notifySuccess('Saved');
    },
    onError: (err) => {
      if (!applyServerErrors(form, err)) notifyError(err, 'Could not save export settings');
    },
  });
  const sendTest = useMutation({
    mutationFn: () => apiFetch(api.settings.testExport),
    onSuccess: setTest,
    onError: (err) => notifyError(err, 'Could not send the test event'),
  });
  const e = form.formState.errors;
  return (
    <form noValidate onSubmit={form.handleSubmit((v) => save.mutate(v))} className="flex flex-col gap-5">
      {envSourced ? (
        <Alert>
          <LockIcon />
          <AlertDescription>Export is configured via environment variables. Change it in the deployment, then restart.</AlertDescription>
        </Alert>
      ) : null}
      <Section title="Audit webhook" description="Each audit event is POSTed as JSON and signed with HMAC-SHA256 using the signing secret.">
        <div className="flex flex-col gap-4">
          <Field data-invalid={!!e.webhookUrl}>
            <FieldLabel htmlFor="webhook-url">Webhook URL</FieldLabel>
            <Input id="webhook-url" type="url" placeholder="https://siem.example/neurouter" disabled={readOnly} aria-invalid={!!e.webhookUrl} {...form.register('webhookUrl')} />
            <FieldError errors={[e.webhookUrl]} />
          </Field>
          <Field data-invalid={!!e.webhookSecret}>
            <FieldLabel htmlFor="webhook-secret">Signing secret</FieldLabel>
            {replacing ? (
              <>
                <Input id="webhook-secret" type="password" autoComplete="new-password" aria-invalid={!!e.webhookSecret} {...form.register('webhookSecret')} />
                <FieldDescription>Write-only: it is stored encrypted and never shown again.</FieldDescription>
              </>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone={ex.hasWebhookSecret ? 'ok' : 'muted'} icon={ex.hasWebhookSecret ? LockIcon : undefined}>
                  {ex.hasWebhookSecret ? 'A secret is set' : 'No secret'}
                </Pill>
                {!readOnly ? (
                  <Button type="button" variant="outline" size="sm" onClick={() => setReplacing(true)}>
                    {ex.hasWebhookSecret ? 'Replace secret' : 'Set secret'}
                  </Button>
                ) : null}
              </div>
            )}
            <FieldError errors={[e.webhookSecret]} />
          </Field>
          <Controller
            control={form.control}
            name="webhookEnabled"
            render={({ field }) => (
              <label className="flex items-start gap-3">
                <Switch checked={field.value} onCheckedChange={field.onChange} disabled={readOnly} className="mt-0.5" />
                <span className="flex flex-col">
                  <span className="font-medium">Deliver audit events</span>
                  <span className="text-[13px] text-muted-foreground">Off: the URL is kept but nothing is sent.</span>
                </span>
              </label>
            )}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" disabled={roleReadOnly || !ex.webhookUrl || sendTest.isPending} onClick={() => sendTest.mutate()}>
              {sendTest.isPending ? <Spinner /> : null}
              Send test event
            </Button>
            {test ? (
              <span role="status" className="text-[13px]">
                {test.ok ? (
                  <Pill tone="ok" icon={CheckIcon}>
                    Delivered{test.status ? ` · HTTP ${test.status}` : ''}
                  </Pill>
                ) : (
                  <Pill tone="err" icon={XIcon}>
                    Failed{test.status ? ` · HTTP ${test.status}` : ''}
                    {test.error ? ` · ${test.error}` : ''}
                  </Pill>
                )}
              </span>
            ) : !ex.webhookUrl ? (
              <span className="text-[13px] text-muted-foreground">Save a URL first.</span>
            ) : null}
          </div>
        </div>
      </Section>
      <Section title="OpenTelemetry" description="Traces and metrics go to the OTLP endpoint set in the environment (OTEL_EXPORTER_OTLP_ENDPOINT).">
        <DetailList items={[{ label: 'OTLP endpoint', value: ex.otlpEndpoint ? <code className="font-mono text-[12.5px] break-all">{ex.otlpEndpoint}</code> : 'Not configured' }]} />
        <Controller
          control={form.control}
          name="otlpLogsEnabled"
          render={({ field }) => (
            <label className="mt-4 flex items-start gap-3">
              <Switch checked={field.value} onCheckedChange={field.onChange} disabled={readOnly || !ex.otlpEndpoint} className="mt-0.5" />
              <span className="flex flex-col">
                <span className="font-medium">Export audit events as OTLP logs</span>
                <span className="text-[13px] text-muted-foreground">Redacted events only; same content as the webhook.</span>
              </span>
            </label>
          )}
        />
      </Section>
      {!readOnly ? (
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={(!form.formState.isDirty && !replacing) || save.isPending}>
            {save.isPending ? <Spinner /> : null}
            Save
          </Button>
          <UnsavedHint dirty={form.formState.isDirty} />
        </div>
      ) : null}
    </form>
  );
}
