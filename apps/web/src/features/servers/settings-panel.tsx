import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, can, IconSourceUrl, type PinningMode, type ServerDetail, type UpdateServerBody } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { Section } from '@/components/layout/section';
import { ServerIcon } from '@/components/status/server-icon';
import { useMe } from '@/hooks/use-me';
import { apiFetch } from '@/lib/api-client';
import { notifyError, notifySuccess } from '@/lib/notify';
import { serverKeys } from './queries';

/** Settings tab: basics, enable/disable, trusted (admin), pinning mode (admin), sync interval, delete (typed confirmation, admin). */
export function ServerSettingsPanel({ server }: { server: ServerDetail }) {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const canWrite = can(me, 'servers:write', { serverId: server.id });
  const isAdmin = can(me, 'servers:create');
  const [name, setName] = useState(server.name);
  const [description, setDescription] = useState(server.description);
  const [tags, setTags] = useState(server.tags.join(', '));
  const [syncInterval, setSyncInterval] = useState(server.syncIntervalMin ? String(server.syncIntervalMin) : '');
  const [deleting, setDeleting] = useState(false);
  const [iconSource, setIconSource] = useState('');
  const iconValid = !iconSource.trim() || IconSourceUrl.safeParse(iconSource.trim()).success;
  const refreshIcon = useMutation({
    mutationFn: () => apiFetch(api.servers.refreshIcon, { params: { id: server.id } }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: serverKeys.all });
      if (r.ok) notifySuccess('Icon refreshed');
      else notifyError(new Error(r.error ?? 'unknown error'), 'Could not fetch the icon');
    },
    onError: (err) => notifyError(err, 'Could not refresh the icon'),
  });
  const update = useMutation({
    mutationFn: (body: UpdateServerBody) => apiFetch(api.servers.update, { params: { id: server.id }, body }),
    onSuccess: (s) => {
      qc.setQueryData(serverKeys.detail(server.id), s);
      void qc.invalidateQueries({ queryKey: serverKeys.all });
      notifySuccess('Server saved');
    },
    onError: (err) => notifyError(err, 'Could not save the server'),
  });
  const del = useMutation({
    mutationFn: () => apiFetch(api.servers.delete, { params: { id: server.id } }),
    onSuccess: () => {
      notifySuccess(`${server.name} deleted`);
      void qc.invalidateQueries({ queryKey: serverKeys.all });
      void navigate({ to: '/admin/servers' });
    },
    onError: (err) => notifyError(err, 'Could not delete the server'),
  });
  const interval = syncInterval.trim() ? Number(syncInterval) : null;
  const intervalValid = interval === null || (Number.isInteger(interval) && interval >= 1 && interval <= 10_080);
  return (
    <div className="flex flex-col gap-5">
      <Section title="Basics">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!intervalValid) return;
            update.mutate({ name: name.trim(), description, tags: tags.split(',').map((t) => t.trim()).filter(Boolean), syncIntervalMin: interval });
          }}
        >
          <Field>
            <FieldLabel htmlFor="s-name">Name</FieldLabel>
            <Input id="s-name" value={name} disabled={!canWrite} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="s-desc">Description</FieldLabel>
            <Textarea id="s-desc" rows={2} value={description} disabled={!canWrite} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="s-tags">Tags</FieldLabel>
            <Input id="s-tags" value={tags} disabled={!canWrite} onChange={(e) => setTags(e.target.value)} />
          </Field>
          <Field data-invalid={!intervalValid} className="max-w-xs">
            <FieldLabel htmlFor="s-sync">Sync interval (minutes)</FieldLabel>
            <Input id="s-sync" inputMode="numeric" value={syncInterval} disabled={!canWrite} placeholder="default" onChange={(e) => setSyncInterval(e.target.value)} aria-invalid={!intervalValid} />
            <FieldDescription>{intervalValid ? 'Empty uses the gateway default.' : 'Enter 1–10080 minutes.'}</FieldDescription>
          </Field>
          {canWrite ? (
            <Button type="submit" className="w-fit" disabled={update.isPending || !name.trim()}>
              {update.isPending ? <Spinner /> : null}
              Save
            </Button>
          ) : null}
        </form>
      </Section>
      <Section title="Icon">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!iconValid || !iconSource.trim()) return;
            update.mutate({ iconUrl: iconSource.trim() }, { onSuccess: () => setIconSource('') });
          }}
        >
          <div className="flex items-center gap-3">
            <ServerIcon server={server} size="lg" />
            <span className="text-[13px] text-muted-foreground">{server.iconUrl ? 'Served by the gateway from a cached copy.' : 'No icon yet; initials are shown.'}</span>
          </div>
          {canWrite ? (
            <>
              <Field data-invalid={!iconValid}>
                <FieldLabel htmlFor="s-icon">Icon URL</FieldLabel>
                <Input id="s-icon" value={iconSource} placeholder="https://… or data:image/…" onChange={(e) => setIconSource(e.target.value)} aria-invalid={!iconValid} />
                <FieldDescription>{iconValid ? 'Overrides the icon the server advertises. The gateway fetches and caches it; browsers never load it directly.' : 'Use an https:// or data:image/ URL.'}</FieldDescription>
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="outline" disabled={update.isPending || !iconSource.trim() || !iconValid}>
                  Set icon
                </Button>
                {server.iconUrl ? (
                  <Button type="button" variant="ghost" disabled={update.isPending} onClick={() => update.mutate({ iconUrl: null })}>
                    Remove override
                  </Button>
                ) : null}
                <Button type="button" variant="ghost" disabled={refreshIcon.isPending} onClick={() => refreshIcon.mutate()}>
                  {refreshIcon.isPending ? <Spinner /> : null}
                  Refresh icon
                </Button>
              </div>
            </>
          ) : null}
        </form>
      </Section>
      <Section title="State">
        <div className="flex flex-col gap-4">
          <label className="flex items-start gap-3">
            <Switch className="mt-0.5" checked={server.enabled} disabled={!canWrite} onCheckedChange={(v) => update.mutate({ enabled: v })} />
            <span className="flex flex-col">
              <span className="font-medium">Enabled</span>
              <span className="text-[13px] text-muted-foreground">Disabling blocks every tool on this server immediately.</span>
            </span>
          </label>
          <label className="flex items-start gap-3">
            <Switch className="mt-0.5" checked={server.trusted} disabled={!isAdmin} onCheckedChange={(v) => update.mutate({ trusted: v })} />
            <span className="flex flex-col">
              <span className="font-medium">Trusted annotations</span>
              <span className="text-[13px] text-muted-foreground">
                Admin only. Shows this server's tool hints (readOnlyHint, destructiveHint…) as trusted in the console. Access decisions never depend on annotations.
              </span>
            </span>
          </label>
        </div>
      </Section>
      <Section title="Definition pinning">
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-muted-foreground">
            Every tool definition is hashed and kept as a version. This decides what happens when the server changes one. Admin only.
          </p>
          <RadioGroup
            value={server.pinningMode}
            onValueChange={(v) => update.mutate({ pinningMode: v as PinningMode })}
            disabled={!isAdmin || update.isPending}
            aria-label="Definition pinning"
            className="gap-3"
          >
            <div className="flex items-start gap-3">
              <RadioGroupItem value="strict" id="pinning-strict" className="mt-0.5" />
              <Label htmlFor="pinning-strict" className="flex flex-col items-start gap-0.5 font-normal">
                <span className="font-medium">Strict (recommended for third-party servers)</span>
                <span className="text-[13px] text-muted-foreground">New and changed definitions are blocked until an owner reviews the diff and approves it.</span>
              </Label>
            </div>
            <div className="flex items-start gap-3">
              <RadioGroupItem value="monitor" id="pinning-monitor" className="mt-0.5" />
              <Label htmlFor="pinning-monitor" className="flex flex-col items-start gap-0.5 font-normal">
                <span className="font-medium">Monitor (for servers you build and review yourselves)</span>
                <span className="text-[13px] text-muted-foreground">
                  Changes apply on the next sync without review. Each one is kept as a version, audited and marked “Applied automatically” on the tool.
                </span>
              </Label>
            </div>
          </RadioGroup>
        </div>
      </Section>
      {isAdmin ? (
        <div className="flex flex-wrap items-center gap-4 rounded-xl border border-destructive/30 bg-card p-4">
          <div className="flex min-w-72 flex-1 flex-col gap-0.5">
            <h2 className="text-[15px] font-semibold">Delete server</h2>
            <p className="text-[13.5px] text-muted-foreground">Disables the server and blocks its tools. Audit history is kept. You'll be asked to type the slug.</p>
          </div>
          <Button variant="outline" className="border-destructive/30 text-destructive" onClick={() => setDeleting(true)}>
            Delete {server.name}
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${server.name}?`}
        description="Every tool on it stops working for all agents. Grants are kept for the audit trail."
        confirmLabel="Delete server"
        confirmText={server.slug}
        pending={del.isPending}
        onConfirm={() => del.mutate()}
      />
    </div>
  );
}
