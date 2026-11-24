import { useState } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LockIcon } from 'lucide-react';
import { api, can, type Role, type UserDetail } from '@neurouter/shared';
import { AreaError, guard } from '@/app/route-guards';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { ErrorState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { DetailList, Page, Section } from '@/components/layout/section';
import { UserAvatar } from '@/components/layout/user-avatar';
import { Pill } from '@/components/status/status';
import { userKeys, userQuery } from '@/features/users/queries';
import { useMe } from '@/hooks/use-me';
import { apiFetch } from '@/lib/api-client';
import { formatDate, formatRelative } from '@/lib/format';
import { notifyError, notifySuccess } from '@/lib/notify';

export const Route = createFileRoute('/_app/admin/users/$userId')({
  staticData: { crumbs: ['Administration', 'Users'], readOnly: { read: 'users:read', write: 'users:write' } },
  beforeLoad: guard(['users:read']),
  errorComponent: AreaError,
  component: UserDetailPage,
});

const ROLES: { role: Role; label: string; hint: string }[] = [
  { role: 'admin', label: 'Admin', hint: 'Full control of the gateway, including other admins.' },
  { role: 'auditor', label: 'Auditor', hint: 'Read-only access to everything, plus audit export and chain verification.' },
];

function RolesEditor({ user, canWrite, isSelf }: { user: UserDetail; canWrite: boolean; isSelf: boolean }) {
  const qc = useQueryClient();
  const [confirmAdmin, setConfirmAdmin] = useState(false);
  const save = useMutation({
    mutationFn: (roles: Role[]) => apiFetch(api.users.update, { params: { id: user.id }, body: { roles } }),
    onSuccess: (u) => {
      qc.setQueryData(userQuery(user.id).queryKey, u);
      void qc.invalidateQueries({ queryKey: userKeys.all });
      notifySuccess('Roles updated');
      setConfirmAdmin(false);
    },
    onError: (err) => notifyError(err, 'Could not update roles'),
  });
  const toggle = (role: Role, on: boolean) => {
    if (role === 'admin' && on) return setConfirmAdmin(true);
    save.mutate(on ? [...user.roles, role] : user.roles.filter((r) => r !== role));
  };
  return (
    <Section title="Roles" description="Everyone is a User. Server Owner comes from owning a server. Roles from IdP mappings are re-applied at each login.">
      <div className="flex flex-col gap-3">
        {ROLES.map((r) => {
          const checked = user.roles.includes(r.role);
          const selfAdminLock = isSelf && r.role === 'admin' && checked;
          return (
            <label key={r.role} className="flex items-start gap-3">
              <Checkbox className="mt-0.5" checked={checked} disabled={!canWrite || save.isPending || selfAdminLock} onCheckedChange={(v) => toggle(r.role, Boolean(v))} />
              <span className="flex flex-col">
                <span className="font-medium">{r.label}</span>
                <span className="text-[13px] text-muted-foreground">{selfAdminLock ? "You can't remove your own Admin role." : r.hint}</span>
              </span>
            </label>
          );
        })}
      </div>
      <ConfirmDialog
        open={confirmAdmin}
        onOpenChange={setConfirmAdmin}
        destructive={false}
        title={`Make ${user.name} an Admin?`}
        description="Admins can change every server, grant, setting and role, including yours."
        confirmLabel="Grant Admin"
        pending={save.isPending}
        onConfirm={() => save.mutate([...user.roles, 'admin'])}
      />
    </Section>
  );
}

function UserDetailPage() {
  const { userId } = Route.useParams();
  const me = useMe();
  const qc = useQueryClient();
  const q = useQuery(userQuery(userId));
  const [confirmStatus, setConfirmStatus] = useState(false);
  const canWrite = can(me, 'users:write');
  const status = useMutation({
    mutationFn: (next: 'active' | 'disabled') => apiFetch(api.users.update, { params: { id: userId }, body: { status: next } }),
    onSuccess: (u) => {
      qc.setQueryData(userQuery(userId).queryKey, u);
      void qc.invalidateQueries({ queryKey: userKeys.all });
      notifySuccess(u.status === 'disabled' ? `${u.name} disabled` : `${u.name} enabled`);
      setConfirmStatus(false);
    },
    onError: (err) => notifyError(err, 'Could not change the status'),
  });
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const u = q.data;
  if (!u) return <Skeleton className="h-64 w-full max-w-3xl" />;
  const isSelf = u.id === me.user.id;
  return (
    <Page width="form">
      <PageHeader
        title={u.name}
        description={u.email}
        actions={
          canWrite && !isSelf ? (
            <Button variant={u.status === 'active' ? 'outline' : 'default'} className={u.status === 'active' ? 'text-destructive' : ''} onClick={() => setConfirmStatus(true)}>
              {u.status === 'active' ? 'Disable user' : 'Enable user'}
            </Button>
          ) : undefined
        }
      />
      <Section>
        <div className="flex items-start gap-4">
          <UserAvatar name={u.name} className="size-12" />
          <DetailList
            className="flex-1"
            items={[
              { label: 'Status', value: u.status === 'active' ? <Pill tone="ok">Active</Pill> : <Pill tone="err">Disabled</Pill> },
              { label: 'Last login', value: formatRelative(u.lastLoginAt) },
              { label: 'Created', value: formatDate(u.createdAt) },
              { label: 'Identity provider', value: u.oidcLinked ? 'Linked (OIDC)' : 'Not linked yet' },
            ]}
          />
        </div>
      </Section>
      <RolesEditor user={u} canWrite={canWrite} isSelf={isSelf} />
      <Section title="Groups" description="IdP groups sync at each login and are read-only here; manage local groups on the group page.">
        {u.groups.length === 0 ? <p className="text-muted-foreground">Not in any group.</p> : null}
        <ul className="flex flex-col divide-y">
          {u.groups.map((g) => (
            <li key={g.id} className="flex items-center gap-2 py-2">
              <Link to="/admin/groups/$groupId" params={{ groupId: g.id }} className="font-medium underline-offset-4 hover:underline">
                {g.name}
              </Link>
              {g.source === 'oidc' ? (
                <Pill tone="muted" icon={LockIcon}>
                  from IdP
                </Pill>
              ) : (
                <Pill tone="outline">local</Pill>
              )}
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Agents" description="Agents this user owns.">
        {u.agents.length === 0 ? <p className="text-muted-foreground">No agents.</p> : null}
        <ul className="flex flex-wrap gap-2">
          {u.agents.map((a) => (
            <li key={a.id}>
              <Link to="/agents/$agentId" params={{ agentId: a.id }} className="inline-flex rounded-lg border px-2.5 py-1 text-[13px] hover:bg-muted">
                {a.name}
              </Link>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Effective access" description="Explain why this user can or can't call a tool.">
        <Link to="/admin/access-control" search={{ check: 'user', subjectId: u.id }} className="text-[13.5px] font-medium underline-offset-4 hover:underline">
          Check access for {u.name} →
        </Link>
      </Section>
      <ConfirmDialog
        open={confirmStatus}
        onOpenChange={setConfirmStatus}
        destructive={u.status === 'active'}
        title={u.status === 'active' ? `Disable ${u.name}?` : `Enable ${u.name}?`}
        description={u.status === 'active' ? 'Disables sign-in and every key and OAuth token of their agents. Audit history is kept.' : 'They can sign in again. Revoked keys stay revoked.'}
        confirmLabel={u.status === 'active' ? 'Disable user' : 'Enable user'}
        pending={status.isPending}
        onConfirm={() => status.mutate(u.status === 'active' ? 'disabled' : 'active')}
      />
    </Page>
  );
}
