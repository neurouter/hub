import { useEffect, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as z from 'zod';
import { PencilIcon, PlusIcon, ShieldIcon, Trash2Icon } from 'lucide-react';
import { api, type RedactionRule, type RedactionTestResult } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { JsonViewer } from '@/components/code/json-viewer';
import { DataTable, type ColumnSpec } from '@/components/data-table/data-table';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { EmptyState } from '@/components/feedback/states';
import { Segmented } from '@/components/filters/segmented';
import { Section } from '@/components/layout/section';
import { Pill } from '@/components/status/status';
import { apiFetch, applyServerErrors } from '@/lib/api-client';
import { notifyError, notifySuccess } from '@/lib/notify';

export const redactionKeys = { rules: ['settings', 'redaction-rules'] as const };

export function redactionRulesQuery() {
  return queryOptions({ queryKey: redactionKeys.rules, queryFn: ({ signal }) => apiFetch(api.redaction.list, { signal }), staleTime: 60_000 });
}

/**
 * Client-side pattern check, same flags as the server engine (key rules match parameter names
 * case-insensitively; regex rules match string values). The server re-validates (and rejects slow
 * patterns with 422).
 */
export function patternError(type: 'key' | 'regex', pattern: string): string | null {
  if (!pattern) return 'Enter a pattern';
  try {
    new RegExp(pattern, type === 'key' ? 'i' : 'g');
    return null;
  } catch (e) {
    return `Invalid regular expression: ${e instanceof Error ? e.message.replace(/^Invalid regular expression: /, '') : 'syntax error'}`;
  }
}

/** Parses the test panel's sample (must be a JSON object, like tool arguments). */
export function parseSample(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const v: unknown = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'The sample must be a JSON object, like tool arguments.' };
    return { ok: true, value: v as Record<string, unknown> };
  } catch {
    return { ok: false, error: 'Not valid JSON.' };
  }
}

const ruleSchema = z
  .object({
    name: z.string().trim().min(1, 'Enter a name').max(100),
    type: z.enum(['key', 'regex']),
    pattern: z.string().min(1, 'Enter a pattern').max(1000),
    replacement: z.string().max(200),
  })
  .superRefine((v, ctx) => {
    const err = patternError(v.type, v.pattern);
    if (err) ctx.addIssue({ code: 'custom', path: ['pattern'], message: err });
  });
type RuleForm = z.infer<typeof ruleSchema>;

function RuleDialog({ open, rule, onOpenChange }: { open: boolean; rule: RedactionRule | null; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const defaults: RuleForm = rule ? { name: rule.name, type: rule.type, pattern: rule.pattern, replacement: rule.replacement } : { name: '', type: 'key', pattern: '', replacement: '' };
  const form = useForm<RuleForm>({ resolver: zodResolver(ruleSchema), defaultValues: defaults });
  useEffect(() => {
    if (open) form.reset(defaults);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rule]);
  const save = useMutation({
    mutationFn: (v: RuleForm) =>
      rule ? apiFetch(api.redaction.update, { params: { id: rule.id }, body: v }) : apiFetch(api.redaction.create, { body: { ...v, enabled: true } }),
    onSuccess: () => {
      notifySuccess(rule ? 'Rule updated' : 'Rule added');
      void qc.invalidateQueries({ queryKey: redactionKeys.rules });
      onOpenChange(false);
    },
    onError: (err) => {
      if (!applyServerErrors(form, err)) notifyError(err, 'Could not save the rule');
    },
  });
  const e = form.formState.errors;
  const type = useWatch({ control: form.control, name: 'type' });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{rule ? `Edit ${rule.name}` : 'Add redaction rule'}</DialogTitle>
          <DialogDescription>Matches are replaced before the event is written and hashed into the audit chain, so redacted values are never stored or searchable.</DialogDescription>
        </DialogHeader>
        <form id="rule-form" noValidate onSubmit={form.handleSubmit((v) => save.mutate(v))} className="flex flex-col gap-4">
          <Field data-invalid={!!e.name}>
            <FieldLabel htmlFor="rule-name">Name</FieldLabel>
            <Input id="rule-name" aria-invalid={!!e.name} {...form.register('name')} />
            <FieldError errors={[e.name]} />
          </Field>
          <Field>
            <FieldLabel id="rule-type-label">Matches</FieldLabel>
            <Controller
              control={form.control}
              name="type"
              render={({ field }) => (
                <Segmented label="Rule type" value={field.value} onChange={field.onChange} options={[{ value: 'key', label: 'Parameter names' }, { value: 'regex', label: 'Values (regex)' }]} />
              )}
            />
          </Field>
          <Field data-invalid={!!e.pattern}>
            <FieldLabel htmlFor="rule-pattern">Pattern</FieldLabel>
            <Input id="rule-pattern" className="font-mono" autoComplete="off" spellCheck={false} aria-invalid={!!e.pattern} {...form.register('pattern')} />
            <FieldDescription>
              {type === 'key' ? 'Regular expression tested against each parameter name, case-insensitive. The whole value is replaced.' : 'Regular expression tested against string values. Matching text is replaced inline.'}
            </FieldDescription>
            <FieldError errors={[e.pattern]} />
          </Field>
          <Field data-invalid={!!e.replacement}>
            <FieldLabel htmlFor="rule-replacement">Replacement</FieldLabel>
            <Input id="rule-replacement" placeholder="Default: REDACTED marker with the rule name" {...form.register('replacement')} />
            <FieldError errors={[e.replacement]} />
          </Field>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="rule-form" disabled={save.isPending}>
            {save.isPending ? <Spinner /> : null}
            {rule ? 'Save rule' : 'Add rule'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const SAMPLE = JSON.stringify({ repo: 'acme-corp/payments-api', api_token: 'ghp_example', note: 'connect via postgres://admin:hunter2@db/prod' }, null, 2);

function TestPanel() {
  const [text, setText] = useState(SAMPLE);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RedactionTestResult | null>(null);
  const run = useMutation({
    mutationFn: (sample: Record<string, unknown>) => apiFetch(api.redaction.test, { body: { sample } }),
    onSuccess: setResult,
    onError: (err) => notifyError(err, 'Could not run the test'),
  });
  return (
    <Section title="Test" description="Paste sample tool arguments to preview what the audit log would store. Runs on the server with the exact engine.">
      <div className="grid gap-4 lg:grid-cols-2">
        <Field data-invalid={!!error}>
          <FieldLabel htmlFor="redaction-sample">Sample arguments (JSON)</FieldLabel>
          <Textarea id="redaction-sample" rows={8} className="font-mono text-[12.5px]" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} aria-invalid={!!error} />
          {error ? <FieldError>{error}</FieldError> : null}
          <Button
            variant="outline"
            className="self-start"
            disabled={run.isPending}
            onClick={() => {
              const p = parseSample(text);
              if (!p.ok) {
                setError(p.error);
                return;
              }
              setError(null);
              run.mutate(p.value);
            }}
          >
            {run.isPending ? <Spinner /> : null}
            Preview redaction
          </Button>
        </Field>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Stored as</span>
          {result ? (
            <>
              <JsonViewer value={result.redacted} label="Redacted preview" />
              <span className="text-[13px] text-muted-foreground" role="status">
                {result.matches.length === 0 ? 'No rule matched.' : `${result.matches.length} value${result.matches.length === 1 ? '' : 's'} redacted.`}
              </span>
            </>
          ) : (
            <span className="rounded-lg border border-dashed p-6 text-center text-[13px] text-muted-foreground">Run a preview to see the redacted output.</span>
          )}
        </div>
      </div>
    </Section>
  );
}

/** Settings → Redaction (§5.2): rules table, add/edit dialog, enable switches, and a server-side test panel. */
export function RedactionTab({ readOnly }: { readOnly: boolean }) {
  const qc = useQueryClient();
  const q = useQuery(redactionRulesQuery());
  const [editing, setEditing] = useState<{ rule: RedactionRule | null } | null>(null);
  const [deleting, setDeleting] = useState<RedactionRule | null>(null);
  const toggle = useMutation({
    mutationFn: (v: { rule: RedactionRule; enabled: boolean }) => apiFetch(api.redaction.update, { params: { id: v.rule.id }, body: { enabled: v.enabled } }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: redactionKeys.rules });
      const prev = qc.getQueryData<{ items: RedactionRule[] }>(redactionKeys.rules);
      qc.setQueryData<{ items: RedactionRule[] }>(redactionKeys.rules, (d) => d && { items: d.items.map((r) => (r.id === v.rule.id ? { ...r, enabled: v.enabled } : r)) });
      return { prev };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(redactionKeys.rules, ctx.prev);
      notifyError(err, 'Could not update the rule');
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: redactionKeys.rules }),
  });
  const remove = useMutation({
    mutationFn: (r: RedactionRule) => apiFetch(api.redaction.delete, { params: { id: r.id } }),
    onSuccess: (_x, r) => {
      notifySuccess(`Deleted ${r.name}`);
      setDeleting(null);
      void qc.invalidateQueries({ queryKey: redactionKeys.rules });
    },
    onError: (err) => notifyError(err, 'Could not delete the rule'),
  });
  const rows = q.data ? [...q.data.items].sort((a, b) => a.order - b.order) : undefined;
  const columns: ColumnSpec<RedactionRule>[] = [
    {
      id: 'name',
      header: 'Name',
      priority: 1,
      cell: (r) => (
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{r.name}</span>
          {r.builtin ? <Pill tone="muted">Built-in</Pill> : null}
        </span>
      ),
    },
    { id: 'type', header: 'Matches', priority: 2, cell: (r) => (r.type === 'key' ? 'Parameter names' : 'Values') },
    { id: 'pattern', header: 'Pattern', priority: 2, cell: (r) => <code className="font-mono text-[12.5px] break-all">{r.pattern}</code> },
    { id: 'replacement', header: 'Replacement', cell: (r) => (r.replacement ? <code className="font-mono text-[12.5px]">{r.replacement}</code> : <span className="text-muted-foreground">Marker</span>) },
    {
      id: 'enabled',
      header: 'Enabled',
      priority: 1,
      cell: (r) => <Switch checked={r.enabled} disabled={readOnly} aria-label={`Enable ${r.name}`} onCheckedChange={(enabled) => toggle.mutate({ rule: r, enabled })} />,
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (r) =>
        readOnly || r.builtin ? null : (
          <span className="inline-flex gap-1">
            <Button variant="ghost" size="icon-sm" aria-label={`Edit ${r.name}`} onClick={() => setEditing({ rule: r })}>
              <PencilIcon />
            </Button>
            <Button variant="ghost" size="icon-sm" className="text-destructive" aria-label={`Delete ${r.name}`} onClick={() => setDeleting(r)}>
              <Trash2Icon />
            </Button>
          </span>
        ),
    },
  ];
  return (
    <div className="flex flex-col gap-5">
      <Section
        title="Redaction rules"
        description="Applied in order to tool arguments (and stored outputs) before they reach the audit log. First match wins per value. Built-in rules can be disabled but not edited."
        actions={
          !readOnly ? (
            <Button size="sm" onClick={() => setEditing({ rule: null })}>
              <PlusIcon /> Add rule
            </Button>
          ) : undefined
        }
      >
        <DataTable
          label="Redaction rules"
          columns={columns}
          rows={rows}
          getRowId={(r) => r.id}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => void q.refetch()}
          empty={<EmptyState icon={ShieldIcon} title="No redaction rules" description="Add a rule to keep secrets out of the audit log." />}
        />
      </Section>
      {!readOnly ? <TestPanel /> : null}
      <RuleDialog open={!!editing} rule={editing?.rule ?? null} onOpenChange={(o) => !o && setEditing(null)} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.name ?? ''}?`}
        description="Values this rule matched will be stored unredacted from now on. Events already written stay redacted."
        confirmLabel="Delete rule"
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </div>
  );
}
