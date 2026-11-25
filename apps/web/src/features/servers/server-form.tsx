import { useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import * as z from 'zod';
import { CircleCheckIcon, OctagonXIcon, TriangleAlertIcon } from 'lucide-react';
import { BACKEND_PATHS, ServerAuthIn, ServerTransport, Slug, api, type CreateServerBody, type ServerAuthType, type TestConnectionResult } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { CopyableMono } from '@/components/code/copy-button';
import { EntityPicker, type PickerOption } from '@/components/filters/entity-picker';
import { Section } from '@/components/layout/section';
import { pickerSearch } from '@/features/pickers';
import { apiFetch, applyServerErrors } from '@/lib/api-client';
import { formatDuration } from '@/lib/format';
import { errorMessage } from '@/lib/notify';
import { slugify } from './slug';

/** Register form schema: shared ServerAuthIn (discriminated on auth.type) + UI fields. */
export const serverFormSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  slug: Slug,
  description: z.string().max(2000).optional(),
  tags: z.string().max(1000),
  owner: z.object({ id: z.string(), name: z.string() }).nullable().refine((v) => v !== null, 'Choose an owner'),
  url: z.url('Enter the server URL, e.g. https://mcp.example.com/mcp'),
  transport: ServerTransport,
  auth: ServerAuthIn,
  trusted: z.boolean(),
});
export type ServerFormValues = z.input<typeof serverFormSchema>;

/** Fresh auth object per type: switching type drops the fields of the previous type (W3 test). */
export function defaultAuth(type: ServerAuthType): ServerFormValues['auth'] {
  switch (type) {
    case 'shared_bearer':
      return { type, token: '' };
    case 'shared_header':
      return { type, headerName: '', headerValue: '' };
    case 'per_user_oauth':
      return { type, oauth: { discovery: 'auto', scopes: [] } };
    default:
      return { type: 'none' };
  }
}

export function toCreateBody(v: z.output<typeof serverFormSchema>, libraryEntryId?: string): CreateServerBody {
  const tags = v.tags.split(',').map((t) => t.trim()).filter(Boolean);
  return {
    name: v.name,
    slug: v.slug,
    ...(v.description ? { description: v.description } : {}),
    tags,
    ownerId: v.owner!.id,
    url: v.url,
    transport: v.transport,
    trusted: v.trusted,
    auth: v.auth,
    ...(libraryEntryId ? { libraryEntryId } : {}),
  };
}

const AUTH_OPTIONS: { value: ServerAuthType; label: string; hint: string }[] = [
  { value: 'none', label: 'None', hint: 'The server needs no credentials.' },
  { value: 'shared_bearer', label: 'Shared bearer token', hint: 'One token for every user (Authorization: Bearer).' },
  { value: 'shared_header', label: 'Shared header', hint: 'A custom header such as X-Api-Key.' },
  { value: 'per_user_oauth', label: 'Per-user OAuth', hint: 'Each user connects their own account; calls act as them.' },
];

type AuthErrors = Record<string, { message?: string } | Record<string, { message?: string }> | undefined>;

function TestResult({ r }: { r: TestConnectionResult }) {
  if (!r.ok) {
    return (
      <div role="alert" className="flex gap-2.5 rounded-lg border border-destructive/30 bg-destructive-muted p-3 text-destructive">
        <OctagonXIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div className="flex flex-col gap-0.5 text-[13.5px]">
          <span className="font-medium">Connection failed{r.error ? `: ${r.error.code}` : ''}</span>
          {r.error ? <span className="text-foreground">{r.error.message}</span> : null}
          {r.authRequired ? <span className="text-foreground">The server asked for authentication; check the credentials.</span> : null}
        </div>
      </div>
    );
  }
  return (
    <div role="status" className="flex gap-2.5 rounded-lg border border-success/30 bg-success-muted p-3 text-success">
      <CircleCheckIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="flex flex-col gap-0.5 text-[13.5px] text-foreground">
        <span className="font-medium text-success">Connected in {formatDuration(r.latencyMs)}</span>
        <span>
          {r.serverInfo ? `${r.serverInfo.name} ${r.serverInfo.version}` : 'Unknown server'} · protocol <span className="font-mono">{r.protocolVersion ?? 'unknown'}</span>
          {r.era && r.era !== 'modern' ? ` (${r.era.replace('_', ' ')})` : ''}
        </span>
        <span>{r.toolCount ?? 0} tools found. They'll start disabled until reviewed.</span>
      </div>
    </div>
  );
}

/**
 * Register a server (§5.2, W3): basics, connection, authentication (discriminated union with
 * conditional fields), trust, then Test connection and Register.
 */
export function ServerForm({
  me,
  onRegistered,
  initial,
  libraryEntryId,
}: {
  me: PickerOption;
  onRegistered: (id: string, initialSyncJobId: string) => void;
  /** Pre-fill (e.g. "Add to gateway" from the library). */
  initial?: Partial<ServerFormValues>;
  /** Library entry the server comes from (provenance). */
  libraryEntryId?: string;
}) {
  const form = useForm<ServerFormValues, unknown, z.output<typeof serverFormSchema>>({
    resolver: zodResolver(serverFormSchema),
    defaultValues: { name: '', slug: '', description: '', tags: '', owner: me, url: '', transport: 'streamable_http', auth: { type: 'none' }, trusted: false, ...initial },
  });
  const [slugTouched, setSlugTouched] = useState(!!initial?.slug);
  const authType = useWatch({ control: form.control, name: 'auth.type' });
  const slug = useWatch({ control: form.control, name: 'slug' });
  const discovery = useWatch({ control: form.control, name: 'auth.oauth.discovery' as never }) as unknown as 'auto' | 'manual' | undefined;
  const e = form.formState.errors;
  const ae = e.auth as unknown as AuthErrors | undefined;
  const oauthErr = (ae?.oauth ?? {}) as Record<string, { message?: string } | undefined>;

  const test = useMutation({
    mutationFn: async () => {
      const ok = await form.trigger(['url', 'transport', 'auth']);
      if (!ok) throw new Error('Fix the highlighted fields first.');
      const v = form.getValues();
      return apiFetch(api.servers.testConnection, { body: { url: v.url, transport: v.transport, auth: v.auth as z.infer<typeof ServerAuthIn> } });
    },
  });
  const register = useMutation({
    mutationFn: (v: z.output<typeof serverFormSchema>) => apiFetch(api.servers.create, { body: toCreateBody(v, libraryEntryId) }),
    onSuccess: (s) => onRegistered(s.id, s.initialSync.jobId),
    onError: (err) => applyServerErrors(form, err),
  });

  return (
    <form noValidate onSubmit={form.handleSubmit((v) => register.mutate(v))} className="flex flex-col gap-5">
      <Section title="1 · Basics">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field data-invalid={!!e.name}>
            <FieldLabel htmlFor="srv-name">Name</FieldLabel>
            <Input
              id="srv-name"
              aria-invalid={!!e.name}
              {...form.register('name', {
                onChange: (ev: React.ChangeEvent<HTMLInputElement>) => {
                  if (!slugTouched) form.setValue('slug', slugify(ev.target.value), { shouldValidate: form.formState.isSubmitted });
                },
              })}
            />
            <FieldError errors={[e.name]} />
          </Field>
          <Field data-invalid={!!e.slug}>
            <FieldLabel htmlFor="srv-slug">Slug</FieldLabel>
            <Input id="srv-slug" aria-invalid={!!e.slug} className="font-mono" {...form.register('slug', { onChange: () => setSlugTouched(true) })} />
            <FieldDescription>
              Tools are exposed as <span className="font-mono">{slug || 'slug'}__tool_name</span>.
            </FieldDescription>
            <FieldError errors={[e.slug]} />
          </Field>
        </div>
        <Field className="mt-4">
          <FieldLabel htmlFor="srv-desc">Description</FieldLabel>
          <Textarea id="srv-desc" rows={2} {...form.register('description')} />
        </Field>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="srv-tags">Tags</FieldLabel>
            <Input id="srv-tags" placeholder="engineering, source-control" {...form.register('tags')} />
            <FieldDescription>Comma-separated. Shown as catalog filters.</FieldDescription>
          </Field>
          <Field data-invalid={!!e.owner}>
            <FieldLabel>Owner</FieldLabel>
            <Controller control={form.control} name="owner" render={({ field }) => <EntityPicker label="Owner" value={field.value} onChange={field.onChange} search={pickerSearch.users} queryKey={['users']} />} />
            <FieldDescription>The owner manages tools, grants and approvals for this server.</FieldDescription>
            <FieldError errors={[e.owner as { message?: string } | undefined]} />
          </Field>
        </div>
      </Section>

      <Section title="2 · Connection">
        <Field data-invalid={!!e.url}>
          <FieldLabel htmlFor="srv-url">URL</FieldLabel>
          <Input id="srv-url" aria-invalid={!!e.url} className="font-mono" placeholder="https://mcp.example.com/mcp" {...form.register('url')} />
          <FieldError errors={[e.url]} />
        </Field>
        <Controller
          control={form.control}
          name="transport"
          render={({ field }) => (
            <RadioGroup value={field.value} onValueChange={field.onChange} aria-label="Transport" className="mt-4 gap-2">
              <div className="flex items-center gap-3">
                <RadioGroupItem value="streamable_http" id="tr-http" />
                <Label htmlFor="tr-http" className="font-normal">Streamable HTTP</Label>
              </div>
              <div className="flex items-center gap-3">
                <RadioGroupItem value="sse" id="tr-sse" />
                <Label htmlFor="tr-sse" className="font-normal">SSE (legacy)</Label>
              </div>
            </RadioGroup>
          )}
        />
      </Section>

      <Section title="3 · Authentication" description="Secrets are encrypted at rest and never shown again after saving.">
        <Controller
          control={form.control}
          name="auth.type"
          render={({ field }) => (
            <RadioGroup
              value={field.value}
              onValueChange={(v) => form.setValue('auth', defaultAuth(v as ServerAuthType), { shouldDirty: true })}
              aria-label="Authentication type"
              className="gap-2"
            >
              {AUTH_OPTIONS.map((o) => (
                <div key={o.value} className="flex items-start gap-3">
                  <RadioGroupItem value={o.value} id={`auth-${o.value}`} className="mt-0.5" />
                  <Label htmlFor={`auth-${o.value}`} className="flex flex-col items-start gap-0 font-normal">
                    <span className="font-medium">{o.label}</span>
                    <span className="text-[13px] text-muted-foreground">{o.hint}</span>
                  </Label>
                </div>
              ))}
            </RadioGroup>
          )}
        />
        <div className="mt-4 flex flex-col gap-4">
          {authType === 'shared_bearer' ? (
            <Field data-invalid={!!ae?.token}>
              <FieldLabel htmlFor="auth-token">Token</FieldLabel>
              <Input id="auth-token" type="password" autoComplete="off" aria-invalid={!!ae?.token} {...form.register('auth.token' as never)} />
              <FieldError errors={[ae?.token as { message?: string } | undefined]} />
            </Field>
          ) : null}
          {authType === 'shared_header' ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!ae?.headerName}>
                <FieldLabel htmlFor="auth-hname">Header name</FieldLabel>
                <Input id="auth-hname" className="font-mono" placeholder="X-Api-Key" aria-invalid={!!ae?.headerName} {...form.register('auth.headerName' as never)} />
                <FieldError errors={[ae?.headerName as { message?: string } | undefined]} />
              </Field>
              <Field data-invalid={!!ae?.headerValue}>
                <FieldLabel htmlFor="auth-hvalue">Header value</FieldLabel>
                <Input id="auth-hvalue" type="password" autoComplete="off" aria-invalid={!!ae?.headerValue} {...form.register('auth.headerValue' as never)} />
                <FieldError errors={[ae?.headerValue as { message?: string } | undefined]} />
              </Field>
            </div>
          ) : null}
          {authType === 'per_user_oauth' ? (
            <>
              <Controller
                control={form.control}
                name={'auth.oauth.discovery' as never}
                render={({ field }) => (
                  <RadioGroup value={field.value as string} onValueChange={field.onChange} aria-label="Authorization server" className="gap-2">
                    <div className="flex items-center gap-3">
                      <RadioGroupItem value="auto" id="disc-auto" />
                      <Label htmlFor="disc-auto" className="font-normal">Discover from the server (recommended)</Label>
                    </div>
                    <div className="flex items-center gap-3">
                      <RadioGroupItem value="manual" id="disc-manual" />
                      <Label htmlFor="disc-manual" className="font-normal">Enter the authorization server URL</Label>
                    </div>
                  </RadioGroup>
                )}
              />
              {discovery === 'manual' ? (
                <Field data-invalid={!!oauthErr.authorizationServerUrl}>
                  <FieldLabel htmlFor="oauth-as">Authorization server URL</FieldLabel>
                  <Input id="oauth-as" className="font-mono" {...form.register('auth.oauth.authorizationServerUrl' as never)} />
                  <FieldError errors={[oauthErr.authorizationServerUrl]} />
                </Field>
              ) : null}
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="oauth-cid">Client ID</FieldLabel>
                  <Input id="oauth-cid" className="font-mono" {...form.register('auth.oauth.clientId' as never, { setValueAs: (v: string) => v || undefined })} />
                  <FieldDescription>Leave empty to use the gateway's metadata document or dynamic registration.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="oauth-secret">Client secret</FieldLabel>
                  <Input id="oauth-secret" type="password" autoComplete="off" {...form.register('auth.oauth.clientSecret' as never, { setValueAs: (v: string) => v || undefined })} />
                </Field>
              </div>
              <Controller
                control={form.control}
                name={'auth.oauth.scopes' as never}
                render={({ field }) => (
                  <Field>
                    <FieldLabel htmlFor="oauth-scopes">Scopes</FieldLabel>
                    <Input
                      id="oauth-scopes"
                      className="font-mono"
                      placeholder="repo read:org"
                      defaultValue={((field.value as string[] | undefined) ?? []).join(' ')}
                      onChange={(ev) => field.onChange(ev.target.value.split(/[\s,]+/).filter(Boolean))}
                    />
                  </Field>
                )}
              />
              <div className="flex flex-col gap-1">
                <span className="text-[13px] font-medium">Callback URL to register with the provider</span>
                <CopyableMono value={`${window.location.origin}${BACKEND_PATHS.upstreamCallback}`} ariaLabel="Copy callback URL" />
              </div>
            </>
          ) : null}
        </div>
      </Section>

      <Section title="4 · Trust">
        <Controller
          control={form.control}
          name="trusted"
          render={({ field }) => (
            <label className="flex items-start gap-3">
              <Switch className="mt-0.5" checked={field.value} onCheckedChange={field.onChange} />
              <span className="flex flex-col">
                <span className="font-medium">Trust tool annotations from this server</span>
                <span className="flex items-center gap-1 text-[13px] text-warning">
                  <TriangleAlertIcon className="size-3.5" aria-hidden="true" />
                  Only for servers you control: hints like readOnlyHint can then influence policy.
                </span>
              </span>
            </label>
          )}
        />
      </Section>

      {test.data ? <TestResult r={test.data} /> : null}
      {test.error ? <p role="alert" className="text-[13.5px] text-destructive">{errorMessage(test.error)}</p> : null}
      {register.error ? <p role="alert" className="text-[13.5px] text-destructive">{errorMessage(register.error)}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>
          {test.isPending ? <Spinner /> : null}
          Test connection
        </Button>
        <Button type="submit" disabled={register.isPending}>
          {register.isPending ? <Spinner /> : null}
          Register server
        </Button>
      </div>
    </form>
  );
}
