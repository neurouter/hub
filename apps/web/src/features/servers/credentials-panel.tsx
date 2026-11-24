import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, can, type PutCredentialsBody, type ServerDetail } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { CopyableMono } from '@/components/code/copy-button';
import { DetailList, Section } from '@/components/layout/section';
import { Pill } from '@/components/status/status';
import { useMe } from '@/hooks/use-me';
import { apiFetch } from '@/lib/api-client';
import { DASH, formatDate } from '@/lib/format';
import { notifyError, notifySuccess } from '@/lib/notify';
import { serverKeys } from './queries';

const TYPE_LABEL = { none: 'None', shared_bearer: 'Shared bearer token', shared_header: 'Shared header', per_user_oauth: 'Per-user OAuth' } as const;

export function credentialsBody(type: ServerDetail['auth']['type'], secret: string): PutCredentialsBody | null {
  if (!secret) return null;
  if (type === 'shared_bearer') return { token: secret };
  if (type === 'shared_header') return { headerValue: secret };
  if (type === 'per_user_oauth') return { oauth: { clientSecret: secret } };
  return null;
}

/**
 * Auth & credentials (§5.2): secrets are write-only. The UI shows "set on <date>" and a Replace
 * form; the new value lives only in the input until saved and is cleared afterwards.
 */
export function CredentialsPanel({ server }: { server: ServerDetail }) {
  const me = useMe();
  const qc = useQueryClient();
  const [secret, setSecret] = useState('');
  const [replacing, setReplacing] = useState(false);
  const canReplace = can(me, 'servers:create'); // PUT credentials is admin-only (backend §14.3)
  const save = useMutation({
    mutationFn: (body: PutCredentialsBody) => apiFetch(api.servers.putCredentials, { params: { id: server.id }, body }),
    onSuccess: () => {
      setSecret('');
      setReplacing(false);
      notifySuccess('Secret replaced');
      void qc.invalidateQueries({ queryKey: serverKeys.detail(server.id) });
    },
    onError: (err) => notifyError(err, 'Could not replace the secret'),
  });
  const a = server.auth;
  const secretLabel = a.type === 'shared_header' ? 'Header value' : a.type === 'per_user_oauth' ? 'Client secret' : 'Token';
  return (
    <Section title="Authentication" description="Secrets are encrypted at rest and never returned by the API.">
      <DetailList
        items={[
          { label: 'Type', value: TYPE_LABEL[a.type] },
          ...(a.headerName ? [{ label: 'Header name', value: <span className="font-mono text-[12.5px]">{a.headerName}</span> }] : []),
          ...(a.type !== 'none'
            ? [{ label: secretLabel, value: a.hasSecret ? <span className="flex items-center gap-2"><span aria-hidden="true">•••</span> <Pill tone="ok">set</Pill> {a.secretUpdatedAt ? <span className="text-muted-foreground">on {formatDate(a.secretUpdatedAt)}</span> : null}</span> : <Pill tone="warn">not set</Pill> }]
            : []),
          ...(a.oauth
            ? [
                { label: 'Client ID', value: <span className="font-mono text-[12.5px]">{a.oauth.clientId ?? `${a.oauth.clientIdMode} (automatic)`}</span> },
                { label: 'Scopes', value: <span className="font-mono text-[12.5px]">{a.oauth.scopes.join(' ') || DASH}</span> },
                { label: 'Callback URL', value: <CopyableMono value={a.oauth.callbackUrl} ariaLabel="Copy callback URL" /> },
              ]
            : []),
        ]}
      />
      {canReplace && a.type !== 'none' ? (
        replacing ? (
          <form
            className="mt-4 flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const body = credentialsBody(a.type, secret);
              if (body) save.mutate(body);
            }}
          >
            <Field className="w-72">
              <FieldLabel htmlFor="new-secret">New {secretLabel.toLowerCase()}</FieldLabel>
              <Input id="new-secret" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
            </Field>
            <Button type="submit" disabled={!secret || save.isPending}>
              {save.isPending ? <Spinner /> : null}
              Save secret
            </Button>
            <Button type="button" variant="ghost" onClick={() => { setSecret(''); setReplacing(false); }}>
              Cancel
            </Button>
          </form>
        ) : (
          <Button className="mt-4" variant="outline" onClick={() => setReplacing(true)}>
            Replace {secretLabel.toLowerCase()}
          </Button>
        )
      ) : null}
    </Section>
  );
}
