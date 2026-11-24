import { useState } from 'react';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import * as z from 'zod';
import { PlusIcon, UsersIcon } from 'lucide-react';
import { can, Role, UserStatus, type UserRow } from '@neurouter/shared';
import { AreaError, guard } from '@/app/route-guards';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CursorPager } from '@/components/data-table/cursor-pager';
import { DataTable, type ColumnSpec } from '@/components/data-table/data-table';
import { EmptyState } from '@/components/feedback/states';
import { EntityPicker } from '@/components/filters/entity-picker';
import { SearchInput } from '@/components/filters/search-input';
import { PageHeader } from '@/components/layout/page-header';
import { Page, Toolbar } from '@/components/layout/section';
import { UserAvatar } from '@/components/layout/user-avatar';
import { Pill } from '@/components/status/status';
import { filterLabels } from '@/features/audit/search';
import { useFilterNames } from '@/features/lookup/names';
import { pickerSearch } from '@/features/pickers';
import { AddUserDialog } from '@/features/users/add-user-dialog';
import { usersListQuery } from '@/features/users/queries';
import { useMe } from '@/hooks/use-me';
import { useCursorStack } from '@/hooks/use-cursor-stack';
import { formatNumber, formatRelative } from '@/lib/format';

const search = z.object({
  q: z.string().max(200).optional().catch(undefined),
  role: Role.optional().catch(undefined),
  status: UserStatus.optional().catch(undefined),
  groupId: z.string().optional().catch(undefined),
});

export const Route = createFileRoute('/_app/admin/users/')({
  staticData: { crumbs: ['Administration', 'Users'], readOnly: { read: 'users:read', write: 'users:write' } },
  validateSearch: search,
  beforeLoad: guard(['users:read']),
  errorComponent: AreaError,
  component: UsersPage,
});

export const ROLE_LABEL: Record<Role, string> = { admin: 'Admin', auditor: 'Auditor' };

function UsersPage() {
  const me = useMe();
  const [adding, setAdding] = useState(false);
  const s = Route.useSearch();
  useFilterNames([s.groupId]);
  const navigate = useNavigate({ from: Route.fullPath });
  const pager = useCursorStack(JSON.stringify(s));
  const q = useQuery({ ...usersListQuery({ ...s, cursor: pager.cursor ?? undefined, limit: 50 }), placeholderData: keepPreviousData });
  const set = (p: Partial<z.infer<typeof search>>) => void navigate({ search: (prev) => ({ ...prev, ...p }) });
  const columns: ColumnSpec<UserRow>[] = [
    {
      id: 'name',
      header: 'Name',
      priority: 1,
      cell: (u) => (
        <span className="flex items-center gap-2.5">
          <UserAvatar name={u.name} />
          <span className="flex flex-col">
            <Link to="/admin/users/$userId" params={{ userId: u.id }} className="font-medium underline-offset-4 hover:underline">
              {u.name}
            </Link>
            <span className="text-xs text-muted-foreground">{u.email}</span>
          </span>
        </span>
      ),
    },
    {
      id: 'roles',
      header: 'Roles',
      priority: 2,
      cell: (u) => (
        <span className="flex flex-wrap gap-1">
          {u.roles.length ? u.roles.map((r) => <Pill key={r} tone="outline">{ROLE_LABEL[r]}</Pill>) : <span className="text-muted-foreground">User</span>}
        </span>
      ),
    },
    {
      id: 'groups',
      header: 'Groups',
      priority: 2,
      cell: (u) => (
        <span className="flex flex-wrap gap-1">
          {u.groups.slice(0, 2).map((g) => (
            <Pill key={g.id} tone="muted">{g.name}</Pill>
          ))}
          {u.groups.length > 2 ? <Pill tone="muted">+{u.groups.length - 2}</Pill> : null}
        </span>
      ),
    },
    { id: 'status', header: 'Status', cell: (u) => (u.status === 'active' ? <Pill tone="ok">Active</Pill> : <Pill tone="err">Disabled</Pill>) },
    { id: 'login', header: 'Last login', priority: 2, cell: (u) => <span className="text-muted-foreground">{formatRelative(u.lastLoginAt)}</span> },
    { id: 'agents', header: 'Agents', align: 'right', cell: (u) => formatNumber(u.agentCount) },
  ];
  return (
    <Page>
      <PageHeader
        title="Users"
        description="People are created on first sign-in through your identity provider, or added ahead of time."
        actions={
          can(me, 'users:write') ? (
            <Button onClick={() => setAdding(true)}>
              <PlusIcon /> Add user
            </Button>
          ) : undefined
        }
      />
      <Toolbar>
        <SearchInput label="Search users" placeholder="Search name or email…" value={s.q} onChange={(v) => set({ q: v })} />
        <Select value={s.role ?? 'any'} onValueChange={(v) => set({ role: v === 'any' ? undefined : (v as Role) })} items={[{ value: 'any', label: 'All roles' }, { value: 'admin', label: 'Admin' }, { value: 'auditor', label: 'Auditor' }]}>
          <SelectTrigger aria-label="Role" className="h-9 min-w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">All roles</SelectItem>
            <SelectItem value="admin">Admin</SelectItem>
            <SelectItem value="auditor">Auditor</SelectItem>
          </SelectContent>
        </Select>
        <Select value={s.status ?? 'any'} onValueChange={(v) => set({ status: v === 'any' ? undefined : (v as UserStatus) })} items={[{ value: 'any', label: 'Any status' }, { value: 'active', label: 'Active' }, { value: 'disabled', label: 'Disabled' }]}>
          <SelectTrigger aria-label="Status" className="h-9 min-w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Any status</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="disabled">Disabled</SelectItem>
          </SelectContent>
        </Select>
        <EntityPicker
          chip
          label="Group"
          value={s.groupId ? { id: s.groupId, name: filterLabels.get(s.groupId) ?? s.groupId.slice(0, 8) } : null}
          onChange={(o) => {
            if (o) filterLabels.set(o.id, o.name);
            set({ groupId: o?.id });
          }}
          search={pickerSearch.groups}
          queryKey={['groups']}
        />
      </Toolbar>
      <DataTable
        label="Users"
        columns={columns}
        rows={q.data?.items}
        getRowId={(u) => u.id}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        onRowClick={(u) => void navigate({ to: '/admin/users/$userId', params: { userId: u.id } })}
        empty={<EmptyState icon={UsersIcon} title="No users match these filters" />}
      />
      <CursorPager page={pager.page} hasPrev={pager.hasPrev} hasNext={!!q.data?.nextCursor} onPrev={pager.prev} onNext={() => pager.next(q.data?.nextCursor)} total={q.data?.totalEstimate} />
      <AddUserDialog open={adding} onOpenChange={setAdding} />
    </Page>
  );
}
