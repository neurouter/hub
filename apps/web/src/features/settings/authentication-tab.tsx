import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { InfoIcon, TrashIcon } from 'lucide-react';
import { api, type OidcSettings, type Role, type RoleMapping } from '@neurouter/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { CopyableMono } from '@/components/code/copy-button';
import { DetailList, Section } from '@/components/layout/section';
import { Pill } from '@/components/status/status';
import { apiFetch } from '@/lib/api-client';
import { DASH } from '@/lib/format';
import { notifyError, notifySuccess } from '@/lib/notify';
import { settingsKeys } from './queries';
import { UnsavedHint, useUnsavedGuard } from './unsaved-guard';

const ROLE_ITEMS = [
  { value: 'admin', label: 'Admin' },
  { value: 'auditor', label: 'Auditor' },
];

/**
 * Authentication (W2): OIDC connection is env-only in Phase 1 (read-only display); role mappings
 * (IdP claim value → Admin / Auditor) are editable and saved with PATCH /api/settings/oidc.
 */
export function AuthenticationTab({ oidc, readOnly }: { oidc: OidcSettings; readOnly: boolean }) {
  const qc = useQueryClient();
  const [rows, setRows] = useState<RoleMapping[]>(oidc.roleMappings);
  const [draft, setDraft] = useState<RoleMapping>({ claim: oidc.groupsClaim || 'groups', value: '', role: 'admin' });
  const dirty = JSON.stringify(rows) !== JSON.stringify(oidc.roleMappings);
  useUnsavedGuard(dirty);
  const save = useMutation({
    mutationFn: () => apiFetch(api.settings.updateOidc, { body: { roleMappings: rows } }),
    onSuccess: (o) => {
      qc.setQueryData(settingsKeys.oidc, o);
      setRows(o.roleMappings);
      notifySuccess('Role mappings saved', 'They apply at each user’s next sign-in.');
    },
    onError: (err) => notifyError(err, 'Could not save role mappings'),
  });
  const test = useMutation({
    mutationFn: () => apiFetch(api.settings.testOidc, { body: { issuer: oidc.issuer ?? '' } }),
  });
  return (
    <div className="flex flex-col gap-5">
      <Section
        title="Identity provider (OIDC)"
        actions={
          !readOnly && oidc.issuer ? (
            <Button variant="outline" size="sm" disabled={test.isPending} onClick={() => test.mutate()}>
              {test.isPending ? <Spinner /> : null}
              Test discovery
            </Button>
          ) : undefined
        }
      >
        <Alert className="mb-4">
          <InfoIcon />
          <AlertDescription>Configured via environment variables. Change them in the deployment and restart the gateway.</AlertDescription>
        </Alert>
        <DetailList
          items={[
            { label: 'Issuer', value: <span className="font-mono text-[12.5px] break-all">{oidc.issuer ?? DASH}</span> },
            { label: 'Client ID', value: <span className="font-mono text-[12.5px]">{oidc.clientId ?? DASH}</span> },
            { label: 'Client secret', value: oidc.hasClientSecret ? <Pill tone="ok">set</Pill> : <Pill tone="muted">not set</Pill> },
            { label: 'Scopes', value: <span className="font-mono text-[12.5px]">{oidc.scopes.join(' ')}</span> },
            { label: 'Groups claim', value: <span className="font-mono text-[12.5px]">{oidc.groupsClaim}</span> },
            { label: 'Redirect URI', value: <CopyableMono value={oidc.redirectUri} ariaLabel="Copy redirect URI" /> },
          ]}
        />
        {test.data ? (
          <p role="status" className={test.data.ok ? 'mt-3 text-[13px] text-success' : 'mt-3 text-[13px] text-destructive'}>
            {test.data.ok ? `Discovery OK · authorization endpoint ${test.data.authorizationEndpoint}` : `Discovery failed: ${test.data.error}`}
          </p>
        ) : null}
      </Section>
      <Section title="Role mappings" description="Users whose ID token claim matches get the role at sign-in. Removing a mapping removes the role at their next sign-in.">
        <table className="w-full text-sm" aria-label="Role mappings">
          <thead>
            <tr className="border-b text-left text-[12.5px] text-muted-foreground">
              <th className="py-2 font-medium">Claim</th>
              <th className="py-2 font-medium">Value</th>
              <th className="py-2 font-medium">Role</th>
              <th className="py-2">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-3 text-muted-foreground">
                  No role mappings. Roles can still be set per user.
                </td>
              </tr>
            ) : null}
            {rows.map((r, i) => (
              <tr key={`${r.claim}=${r.value}→${r.role}`} className="border-b last:border-0">
                <td className="py-2 font-mono text-[12.5px]">{r.claim}</td>
                <td className="py-2 font-mono text-[12.5px]">{r.value}</td>
                <td className="py-2">
                  <Pill tone="outline">{r.role === 'admin' ? 'Admin' : 'Auditor'}</Pill>
                </td>
                <td className="py-2 text-right">
                  {!readOnly ? (
                    <Button variant="ghost" size="icon-sm" aria-label={`Remove mapping ${r.value} → ${r.role}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                      <TrashIcon />
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!readOnly ? (
          <form
            className="mt-4 flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!draft.claim.trim() || !draft.value.trim()) return;
              setRows([...rows, { claim: draft.claim.trim(), value: draft.value.trim(), role: draft.role }]);
              setDraft({ ...draft, value: '' });
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rm-claim">Claim</Label>
              <Input id="rm-claim" className="h-9 w-36 font-mono" value={draft.claim} onChange={(e) => setDraft({ ...draft, claim: e.target.value })} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rm-value">Value</Label>
              <Input id="rm-value" className="h-9 w-56 font-mono" placeholder="okta-platform-admins" value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rm-role">Role</Label>
              <Select value={draft.role} onValueChange={(v) => setDraft({ ...draft, role: v as Role })} items={ROLE_ITEMS}>
                <SelectTrigger id="rm-role" className="h-9 w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_ITEMS.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" variant="outline" disabled={!draft.value.trim()}>
              Add mapping
            </Button>
          </form>
        ) : null}
        {!readOnly ? (
          <div className="mt-4 flex items-center gap-3 border-t pt-4">
            <Button disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? <Spinner /> : null}
              Save role mappings
            </Button>
            {dirty ? (
              <Button variant="ghost" onClick={() => setRows(oidc.roleMappings)}>
                Discard
              </Button>
            ) : null}
            <UnsavedHint dirty={dirty} />
          </div>
        ) : null}
      </Section>
    </div>
  );
}
