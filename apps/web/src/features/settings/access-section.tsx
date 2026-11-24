import { useEffect } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as z from 'zod';
import { api, type Settings, type UpdateSettingsBody } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Segmented } from '@/components/filters/segmented';
import { Section } from '@/components/layout/section';
import { apiFetch, applyServerErrors } from '@/lib/api-client';
import { notifyError, notifySuccess } from '@/lib/notify';
import { settingsKeys } from './queries';
import { UnsavedHint, useUnsavedGuard } from './unsaved-guard';

const HOST = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i;

/** One host per line (or comma-separated); trimmed, lower-cased, de-duplicated. */
export function parseHosts(text: string): string[] {
  return [...new Set(text.split(/[\n,]/).map((h) => h.trim().toLowerCase()).filter(Boolean))];
}

const schema = z
  .object({
    catalogVisibility: z.enum(['all', 'granted']),
    dcrEnabled: z.boolean(),
    cimdMode: z.enum(['any', 'allowlist']),
    hosts: z.string().max(10_000),
  })
  .superRefine((v, ctx) => {
    const hosts = parseHosts(v.hosts);
    const bad = hosts.find((h) => !HOST.test(h));
    if (bad) ctx.addIssue({ code: 'custom', path: ['hosts'], message: `“${bad}” is not a host name` });
    if (v.cimdMode === 'allowlist' && hosts.length === 0) ctx.addIssue({ code: 'custom', path: ['hosts'], message: 'Add at least one host, or allow any host' });
  });
type Form = z.infer<typeof schema>;

export function accessPatch(v: Form): UpdateSettingsBody {
  return {
    catalogVisibility: v.catalogVisibility,
    oauth: { dcrEnabled: v.dcrEnabled, cimdPolicy: { mode: v.cimdMode, allowedHosts: parseHosts(v.hosts) } },
  };
}

/**
 * General → Catalog and MCP clients: who sees ungranted servers in the catalog, and which OAuth
 * clients may register (CIMD host policy, legacy dynamic registration). Its own form and Save.
 */
export function AccessSection({ settings, readOnly }: { settings: Settings; readOnly: boolean }) {
  const qc = useQueryClient();
  const defaults = (s: Settings): Form => ({
    catalogVisibility: s.catalogVisibility,
    dcrEnabled: s.oauth.dcrEnabled,
    cimdMode: s.oauth.cimdPolicy.mode,
    hosts: s.oauth.cimdPolicy.allowedHosts.join('\n'),
  });
  const form = useForm<Form>({ resolver: zodResolver(schema), defaultValues: defaults(settings) });
  useEffect(() => form.reset(defaults(settings)), [settings, form]);
  useUnsavedGuard(form.formState.isDirty);
  const save = useMutation({
    mutationFn: (v: Form) => apiFetch(api.settings.update, { body: accessPatch(v) }),
    onSuccess: (s) => {
      qc.setQueryData(settingsKeys.all, s);
      form.reset(defaults(s));
      notifySuccess('Saved');
    },
    onError: (err) => {
      if (!applyServerErrors(form, err)) notifyError(err, 'Could not save settings');
    },
  });
  const mode = useWatch({ control: form.control, name: 'cimdMode' });
  const e = form.formState.errors;
  return (
    <form noValidate onSubmit={form.handleSubmit((v) => save.mutate(v))} className="flex flex-col gap-5">
      <Section title="Catalog and MCP clients" description="What users can browse, and which MCP clients may sign in with OAuth.">
        <div className="flex flex-col gap-5">
          <Field>
            <FieldLabel>Catalog shows</FieldLabel>
            <Controller
              control={form.control}
              name="catalogVisibility"
              render={({ field }) => (
                <Segmented
                  label="Catalog visibility"
                  value={field.value}
                  onChange={readOnly ? () => {} : field.onChange}
                  options={[
                    { value: 'all', label: 'All servers (request access)' },
                    { value: 'granted', label: 'Only granted servers' },
                  ]}
                />
              )}
            />
          </Field>
          <Field data-invalid={!!e.hosts}>
            <FieldLabel>Client ID metadata documents (CIMD)</FieldLabel>
            <Controller
              control={form.control}
              name="cimdMode"
              render={({ field }) => (
                <Segmented
                  label="CIMD host policy"
                  value={field.value}
                  onChange={readOnly ? () => {} : field.onChange}
                  options={[
                    { value: 'any', label: 'Any host' },
                    { value: 'allowlist', label: 'Only these hosts' },
                  ]}
                />
              )}
            />
            {mode === 'allowlist' ? (
              <>
                <Textarea aria-label="Allowed client hosts" rows={3} className="font-mono text-[12.5px]" placeholder={'claude.ai\n*.cursor.com'} disabled={readOnly} aria-invalid={!!e.hosts} {...form.register('hosts')} />
                <FieldDescription>One host per line. A leading *. matches subdomains.</FieldDescription>
              </>
            ) : null}
            <FieldError errors={[e.hosts]} />
          </Field>
          <Controller
            control={form.control}
            name="dcrEnabled"
            render={({ field }) => (
              <label className="flex items-start gap-3">
                <Switch checked={field.value} onCheckedChange={field.onChange} disabled={readOnly} className="mt-0.5" />
                <span className="flex flex-col">
                  <span className="font-medium">Allow dynamic client registration (legacy)</span>
                  <span className="text-[13px] text-muted-foreground">For clients without a metadata document. Users see an “Unverified app” warning on the consent screen.</span>
                </span>
              </label>
            )}
          />
        </div>
      </Section>
      {!readOnly ? (
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={!form.formState.isDirty || save.isPending}>
            {save.isPending ? <Spinner /> : null}
            Save catalog and client settings
          </Button>
          <UnsavedHint dirty={form.formState.isDirty} />
        </div>
      ) : null}
    </form>
  );
}
