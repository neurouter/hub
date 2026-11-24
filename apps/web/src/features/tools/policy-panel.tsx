import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, can, type ToolDetail, type UpdateToolBody } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Section } from '@/components/layout/section';
import { GrantsTable } from '@/features/grants/grants-table';
import { useMe } from '@/hooks/use-me';
import { apiFetch } from '@/lib/api-client';
import { notifyError, notifySuccess } from '@/lib/notify';
import { toolKeys } from './queries';

/** Parses the override inputs: both empty → inherit (null); otherwise both must be positive ints. */
export function parseRateLimit(perMinute: string, burst: string): { value: UpdateToolBody['rateLimit'] } | { error: string } {
  if (!perMinute.trim() && !burst.trim()) return { value: null };
  const p = Number(perMinute);
  const b = Number(burst);
  if (!Number.isInteger(p) || p < 1 || !Number.isInteger(b) || b < 1) return { error: 'Enter whole numbers ≥ 1 for both, or leave both empty to inherit.' };
  return { value: { perMinute: p, burst: b } };
}

/** Policy tab (§5.2, W4): enabled, requires approval, rate-limit override, and grants for this tool. */
export function PolicyPanel({ tool, defaults }: { tool: ToolDetail; defaults?: { perMinute: number; burst: number } | undefined }) {
  const me = useMe();
  const qc = useQueryClient();
  const canWrite = can(me, 'tools:write', { serverId: tool.server.id });
  const [perMinute, setPerMinute] = useState(tool.rateLimit ? String(tool.rateLimit.perMinute) : '');
  const [burst, setBurst] = useState(tool.rateLimit ? String(tool.rateLimit.burst) : '');
  const [error, setError] = useState<string | null>(null);
  const update = useMutation({
    mutationFn: (body: UpdateToolBody) => apiFetch(api.tools.update, { params: { id: tool.id }, body }),
    onSuccess: (t) => {
      qc.setQueryData(toolKeys.detail(tool.id), t);
      void qc.invalidateQueries({ queryKey: toolKeys.lists() });
      notifySuccess('Policy saved');
    },
    onError: (err) => notifyError(err, 'Could not save the policy'),
  });
  return (
    <div className="flex flex-col gap-5">
      <Section title="Policy">
        <div className="flex flex-col gap-4">
          <label className="flex items-start gap-3">
            <Switch className="mt-0.5" checked={tool.enabled} disabled={!canWrite || tool.reviewState !== 'approved'} onCheckedChange={(v) => update.mutate({ enabled: v })} />
            <span className="flex flex-col">
              <span className="font-medium">Enabled</span>
              <span className="text-[13px] text-muted-foreground">{tool.reviewState !== 'approved'
                  ? tool.enabled
                    ? 'Switched on, but calls are blocked until the pending definition is approved.'
                    : 'Approve the pending definition before enabling.'
                  : 'Disabled tools are hidden from search and calls are blocked.'}</span>
            </span>
          </label>
          <label className="flex items-start gap-3">
            <Switch className="mt-0.5" checked={tool.requiresApproval} disabled={!canWrite} onCheckedChange={(v) => update.mutate({ requiresApproval: v })} />
            <span className="flex flex-col">
              <span className="font-medium">Requires approval</span>
              <span className="text-[13px] text-muted-foreground">Each call waits for a reviewer in Approvals before it runs.</span>
            </span>
          </label>
        </div>
      </Section>
      <Section title="Rate limit override" description="Token bucket for this tool. Leave both empty to inherit the gateway default.">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const r = parseRateLimit(perMinute, burst);
            if ('error' in r) return setError(r.error);
            setError(null);
            update.mutate({ rateLimit: r.value });
          }}
        >
          <Field className="w-44">
            <FieldLabel htmlFor="rl-rpm">Requests per minute</FieldLabel>
            <Input id="rl-rpm" inputMode="numeric" disabled={!canWrite} value={perMinute} placeholder={defaults ? `${defaults.perMinute} (default)` : 'default'} onChange={(e) => setPerMinute(e.target.value)} />
          </Field>
          <Field className="w-44">
            <FieldLabel htmlFor="rl-burst">Burst</FieldLabel>
            <Input id="rl-burst" inputMode="numeric" disabled={!canWrite} value={burst} placeholder={defaults ? `${defaults.burst} (default)` : 'default'} onChange={(e) => setBurst(e.target.value)} />
          </Field>
          {canWrite ? (
            <Button type="submit" variant="outline" disabled={update.isPending}>
              {update.isPending ? <Spinner /> : null}
              Save override
            </Button>
          ) : null}
          {error ? <FieldError className="w-full">{error}</FieldError> : null}
          <FieldDescription className="w-full">Agents also have a per-agent limit (Gateway settings → Rate limits).</FieldDescription>
        </form>
      </Section>
      <Section title="Grants for this tool" bodyClassName="p-0">
        <GrantsTable filter={{ toolId: tool.id }} canWrite={can(me, 'grants:write', { serverId: tool.server.id })} hideTarget />
      </Section>
    </div>
  );
}
