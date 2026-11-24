import { useState } from 'react';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { ListIcon, PlusIcon } from 'lucide-react';
import { api, can, CreateGroupBody, type GroupListItem, type GroupRow } from '@neurouter/shared';
import { AreaError, guard } from '@/app/route-guards';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { CursorPager } from '@/components/data-table/cursor-pager';
import { DataTable, type ColumnSpec } from '@/components/data-table/data-table';
import { EmptyState } from '@/components/feedback/states';
import { SearchInput } from '@/components/filters/search-input';
import { PageHeader } from '@/components/layout/page-header';
import { Page, Toolbar } from '@/components/layout/section';
import { Pill } from '@/components/status/status';
import { groupKeys, groupsListQuery } from '@/features/groups/queries';
import { useCursorStack } from '@/hooks/use-cursor-stack';
import { useMe } from '@/hooks/use-me';
import { apiFetch, applyServerErrors } from '@/lib/api-client';
import { formatNumber } from '@/lib/format';
import { notifyError, notifySuccess } from '@/lib/notify';

export const Route = createFileRoute('/_app/admin/groups/')({
  staticData: { crumbs: ['Administration', 'Groups'], readOnly: { read: 'groups:read', write: 'groups:write' } },
  validateSearch: z.object({ q: z.string().max(200).optional().catch(undefined) }),
  beforeLoad: guard(['groups:read']),
  errorComponent: AreaError,
  component: GroupsPage,
});

const isRow = (g: GroupListItem): g is GroupRow => 'source' in g;

function NewGroupDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const form = useForm<{ name: string; description?: string | undefined }>({ resolver: zodResolver(CreateGroupBody), defaultValues: { name: '', description: '' } });
  const create = useMutation({
    mutationFn: (body: { name: string; description?: string | undefined }) => apiFetch(api.groups.create, { body }),
    onSuccess: (g) => {
      notifySuccess(`Group “${g.name}” created`);
      void qc.invalidateQueries({ queryKey: groupKeys.all });
      onOpenChange(false);
      form.reset();
      void navigate({ to: '/admin/groups/$groupId', params: { groupId: g.id } });
    },
    onError: (err) => {
      if (!applyServerErrors(form, err)) notifyError(err, 'Could not create the group');
    },
  });
  const { errors } = form.formState;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form className="contents" noValidate onSubmit={form.handleSubmit((v) => create.mutate({ name: v.name, ...(v.description ? { description: v.description } : {}) }))}>
          <DialogHeader>
            <DialogTitle>New group</DialogTitle>
            <DialogDescription>Local group. IdP groups appear automatically when people sign in.</DialogDescription>
          </DialogHeader>
          <Field data-invalid={!!errors.name}>
            <FieldLabel htmlFor="group-name">Name</FieldLabel>
            <Input id="group-name" aria-invalid={!!errors.name} {...form.register('name')} />
            <FieldError errors={[errors.name]} />
          </Field>
          <Field>
            <FieldLabel htmlFor="group-description">Description</FieldLabel>
            <Textarea id="group-description" rows={2} {...form.register('description')} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              Create group
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function GroupsPage() {
  const me = useMe();
  const { q } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const pager = useCursorStack(q ?? '');
  const list = useQuery({ ...groupsListQuery({ q, cursor: pager.cursor ?? undefined, limit: 50 }), placeholderData: keepPreviousData });
  const [creating, setCreating] = useState(false);
  const columns: ColumnSpec<GroupRow>[] = [
    {
      id: 'name',
      header: 'Group',
      priority: 1,
      cell: (g) => (
        <span className="flex flex-col">
          <Link to="/admin/groups/$groupId" params={{ groupId: g.id }} className="font-medium underline-offset-4 hover:underline">
            {g.name}
          </Link>
          {g.description ? <span className="max-w-md truncate text-xs text-muted-foreground">{g.description}</span> : null}
        </span>
      ),
    },
    { id: 'source', header: 'Source', priority: 2, cell: (g) => (g.source === 'oidc' ? <Pill tone="muted">IdP (OIDC)</Pill> : <Pill tone="outline">local</Pill>) },
    { id: 'members', header: 'Members', align: 'right', priority: 2, cell: (g) => formatNumber(g.memberCount) },
    { id: 'mappings', header: 'Claim mappings', align: 'right', cell: (g) => formatNumber(g.mappingCount) },
    { id: 'grants', header: 'Grants', align: 'right', cell: (g) => formatNumber(g.grantCount) },
  ];
  return (
    <Page>
      <PageHeader
        title="Groups"
        description="Groups from your identity provider and local groups. Grants to a group apply to every member."
        actions={
          can(me, 'groups:write') ? (
            <Button onClick={() => setCreating(true)}>
              <PlusIcon /> New group
            </Button>
          ) : undefined
        }
      />
      <Toolbar>
        <SearchInput label="Search groups" value={q} onChange={(v) => void navigate({ search: { q: v } })} />
      </Toolbar>
      <DataTable
        label="Groups"
        columns={columns}
        rows={list.data?.items.filter(isRow)}
        getRowId={(g) => g.id}
        loading={list.isLoading}
        error={list.error}
        onRetry={() => void list.refetch()}
        onRowClick={(g) => void navigate({ to: '/admin/groups/$groupId', params: { groupId: g.id } })}
        empty={<EmptyState icon={ListIcon} title={q ? `No groups match “${q}”` : 'No groups yet'} />}
      />
      <CursorPager page={pager.page} hasPrev={pager.hasPrev} hasNext={!!list.data?.nextCursor} onPrev={pager.prev} onNext={() => pager.next(list.data?.nextCursor)} total={list.data?.totalEstimate} />
      <NewGroupDialog open={creating} onOpenChange={setCreating} />
    </Page>
  );
}
