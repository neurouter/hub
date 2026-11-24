import { useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as z from 'zod';
import { LockIcon, TrashIcon } from 'lucide-react';
import { api, can, type ClaimMapping, type GroupMember } from '@neurouter/shared';
import { AreaError, guard } from '@/app/route-guards';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DataTable, type ColumnSpec } from '@/components/data-table/data-table';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { EntityPicker } from '@/components/filters/entity-picker';
import { PageHeader } from '@/components/layout/page-header';
import { Page, Section } from '@/components/layout/section';
import { Pill } from '@/components/status/status';
import { GrantsTable } from '@/features/grants/grants-table';
import { EditGroupDialog } from '@/features/groups/edit-group-dialog';
import { groupKeys, groupMappingsQuery, groupMembersQuery, groupQuery } from '@/features/groups/queries';
import { pickerSearch } from '@/features/pickers';
import { useMe } from '@/hooks/use-me';
import { apiFetch } from '@/lib/api-client';
import { formatDate, formatRelative } from '@/lib/format';
import { notifyError, notifySuccess } from '@/lib/notify';

const TABS = ['members', 'mappings', 'grants'] as const;

export const Route = createFileRoute('/_app/admin/groups/$groupId')({
  staticData: { crumbs: ['Administration', 'Groups'], readOnly: { read: 'groups:read', write: 'groups:write' } },
  validateSearch: z.object({ tab: z.enum(TABS).optional().catch(undefined) }),
  beforeLoad: guard(['groups:read']),
  errorComponent: AreaError,
  component: GroupDetailPage,
});

function Members({ groupId, local, canWrite }: { groupId: string; local: boolean; canWrite: boolean }) {
  const qc = useQueryClient();
  const q = useQuery(groupMembersQuery(groupId));
  const add = useMutation({
    mutationFn: (userId: string) => apiFetch(api.groups.addMembers, { params: { id: groupId }, body: { userIds: [userId] } }),
    onSuccess: () => {
      notifySuccess('Member added');
      void qc.invalidateQueries({ queryKey: groupKeys.detail(groupId) });
    },
    onError: (err) => notifyError(err, 'Could not add the member'),
  });
  const remove = useMutation({
    mutationFn: (userId: string) => apiFetch(api.groups.removeMember, { params: { id: groupId, userId } }),
    onMutate: async (userId) => {
      const key = groupMembersQuery(groupId).queryKey;
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData(key);
      qc.setQueryData(key, (d) => (d ? { ...d, items: d.items.filter((m) => m.user.id !== userId) } : d));
      return { prev };
    },
    onError: (err, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(groupMembersQuery(groupId).queryKey, ctx.prev);
      notifyError(err, 'Could not remove the member');
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: groupKeys.detail(groupId) }),
  });
  const columns: ColumnSpec<GroupMember>[] = [
    { id: 'name', header: 'Name', priority: 1, cell: (m) => <span className="font-medium">{m.user.name}</span> },
    { id: 'email', header: 'Email', priority: 2, cell: (m) => <span className="text-muted-foreground">{m.user.email}</span> },
    { id: 'source', header: 'Source', cell: (m) => (m.source === 'oidc' ? <Pill tone="muted" icon={LockIcon}>from IdP</Pill> : <Pill tone="outline">local</Pill>) },
    { id: 'added', header: 'Added', cell: (m) => <span className="text-muted-foreground">{formatDate(m.addedAt)}</span> },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (m) =>
        canWrite && m.source === 'local' ? (
          <Button variant="ghost" size="icon-sm" aria-label={`Remove ${m.user.name}`} onClick={() => remove.mutate(m.user.id)}>
            <TrashIcon />
          </Button>
        ) : null,
    },
  ];
  return (
    <div className="flex flex-col gap-3">
      {local && canWrite ? (
        <div className="flex items-center gap-2">
          <EntityPicker label="Add member" value={null} onChange={(o) => o && add.mutate(o.id)} search={pickerSearch.users} queryKey={['users']} placeholder="Add member…" />
        </div>
      ) : null}
      {!local ? <p className="text-[13px] text-muted-foreground">Membership is synced from your identity provider at each user's login and can't be edited here.</p> : null}
      <DataTable label="Members" columns={columns} rows={q.data?.items} getRowId={(m) => m.user.id} loading={q.isLoading} error={q.error} empty={<EmptyState title="No members yet" />} />
    </div>
  );
}

function Mappings({ groupId, canWrite }: { groupId: string; canWrite: boolean }) {
  const qc = useQueryClient();
  const q = useQuery(groupMappingsQuery(groupId));
  const [claim, setClaim] = useState('groups');
  const [value, setValue] = useState('');
  const invalidate = () => void qc.invalidateQueries({ queryKey: groupKeys.detail(groupId) });
  const create = useMutation({
    mutationFn: () => apiFetch(api.groups.createClaimMapping, { params: { id: groupId }, body: { claim: claim.trim(), value: value.trim() } }),
    onSuccess: () => {
      setValue('');
      notifySuccess('Mapping added');
      invalidate();
    },
    onError: (err) => notifyError(err, 'Could not add the mapping'),
  });
  const del = useMutation({
    mutationFn: (m: ClaimMapping) => apiFetch(api.groups.deleteClaimMapping, { params: { id: groupId, mappingId: m.id } }),
    onSuccess: invalidate,
    onError: (err) => notifyError(err, 'Could not remove the mapping'),
  });
  const columns: ColumnSpec<ClaimMapping>[] = [
    { id: 'claim', header: 'Claim', priority: 1, cell: (m) => <span className="font-mono text-[12.5px]">{m.claim}</span> },
    { id: 'value', header: 'Value', priority: 1, cell: (m) => <span className="font-mono text-[12.5px]">{m.value}</span> },
    { id: 'seen', header: 'Last seen at login', priority: 2, cell: (m) => <span className="text-muted-foreground">{formatRelative(m.lastSeenAt, undefined, 'Not seen yet')}</span> },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (m) =>
        canWrite ? (
          <Button variant="ghost" size="icon-sm" aria-label={`Remove mapping ${m.claim}=${m.value}`} onClick={() => del.mutate(m)}>
            <TrashIcon />
          </Button>
        ) : null,
    },
  ];
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-muted-foreground">Users whose ID token has a matching claim value join this group at login.</p>
      {canWrite ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (claim.trim() && value.trim()) create.mutate();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mapping-claim">Claim</Label>
            <Input id="mapping-claim" className="h-9 w-40 font-mono" value={claim} onChange={(e) => setClaim(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mapping-value">Value</Label>
            <Input id="mapping-value" className="h-9 w-64 font-mono" value={value} onChange={(e) => setValue(e.target.value)} placeholder="okta-engineering" />
          </div>
          <Button type="submit" disabled={!claim.trim() || !value.trim() || create.isPending}>
            Add mapping
          </Button>
        </form>
      ) : null}
      <DataTable label="Claim mappings" columns={columns} rows={q.data?.items} getRowId={(m) => m.id} loading={q.isLoading} error={q.error} empty={<EmptyState title="No claim mappings" />} />
    </div>
  );
}

function GroupDetailPage() {
  const { groupId } = Route.useParams();
  const { tab = 'members' } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const me = useMe();
  const qc = useQueryClient();
  const q = useQuery(groupQuery(groupId));
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState(false);
  const canWrite = can(me, 'groups:write');
  const del = useMutation({
    mutationFn: () => apiFetch(api.groups.delete, { params: { id: groupId } }),
    onSuccess: () => {
      notifySuccess('Group deleted');
      void qc.invalidateQueries({ queryKey: groupKeys.all });
      void navigate({ to: '/admin/groups' });
    },
    onError: (err) => notifyError(err, 'Could not delete the group'),
  });
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const g = q.data;
  if (!g) return <Skeleton className="h-64 w-full" />;
  return (
    <Page>
      <PageHeader
        title={g.name}
        description={g.description || undefined}
        actions={
          canWrite ? (
            <>
              <Button variant="outline" onClick={() => setEditing(true)}>
                Edit
              </Button>
              {g.source === 'local' ? (
                <Button variant="outline" className="text-destructive" onClick={() => setDeleting(true)}>
                  Delete group
                </Button>
              ) : null}
            </>
          ) : undefined
        }
      />
      {canWrite ? <EditGroupDialog group={g} open={editing} onOpenChange={setEditing} /> : null}
      <div className="-mt-3 flex gap-2">
        {g.source === 'oidc' ? <Pill tone="muted" icon={LockIcon}>IdP group</Pill> : <Pill tone="outline">local group</Pill>}
        <Pill tone="muted">{g.memberCount} members</Pill>
      </div>
      <Tabs value={tab} onValueChange={(v) => void navigate({ search: { tab: v === 'members' ? undefined : (v as (typeof TABS)[number]) }, replace: true })}>
        <TabsList aria-label="Group sections">
          <TabsTrigger value="members">Members</TabsTrigger>
          <TabsTrigger value="mappings">Claim mappings</TabsTrigger>
          <TabsTrigger value="grants">Grants</TabsTrigger>
        </TabsList>
        <TabsContent value="members" className="pt-2">
          <Members groupId={groupId} local={g.source === 'local'} canWrite={canWrite} />
        </TabsContent>
        <TabsContent value="mappings" className="pt-2">
          <Mappings groupId={groupId} canWrite={canWrite} />
        </TabsContent>
        <TabsContent value="grants" className="pt-2">
          <Section title="Grants to this group" bodyClassName="p-0">
            <GrantsTable filter={{ subjectType: 'group', subjectId: groupId }} canWrite={can(me, 'grants:write')} hideSubject />
          </Section>
        </TabsContent>
      </Tabs>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${g.name}?`}
        description="Its grants and claim mappings are removed. Members lose any access granted through this group."
        confirmLabel="Delete group"
        confirmText={g.name}
        pending={del.isPending}
        onConfirm={() => del.mutate()}
      />
    </Page>
  );
}
