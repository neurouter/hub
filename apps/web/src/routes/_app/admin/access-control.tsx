import { useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import * as z from 'zod';
import { PlusIcon } from 'lucide-react';
import { GrantEffect, SubjectType, can } from '@neurouter/shared';
import { AreaError, guard } from '@/app/route-guards';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EntityPicker } from '@/components/filters/entity-picker';
import { Segmented } from '@/components/filters/segmented';
import { PageHeader } from '@/components/layout/page-header';
import { Page, Toolbar } from '@/components/layout/section';
import { filterLabels } from '@/features/audit/search';
import { useFilterNames } from '@/features/lookup/names';
import { AccessMatrix } from '@/features/grants/access-matrix';
import { AddGrantDialog } from '@/features/grants/add-grant-dialog';
import { CheckAccessSheet } from '@/features/grants/check-access-sheet';
import { GrantsTable } from '@/features/grants/grants-table';
import { pickerSearch } from '@/features/pickers';
import { useMe } from '@/hooks/use-me';
import { useMinWidth } from '@/hooks/use-min-width';

const search = z.object({
  view: z.enum(['list', 'matrix']).optional().catch(undefined),
  server: z.string().optional().catch(undefined),
  subjectType: SubjectType.optional().catch(undefined),
  effect: GrantEffect.optional().catch(undefined),
  /** open Check access for a subject (from the user page) */
  check: z.enum(['user', 'agent']).optional().catch(undefined),
  subjectId: z.string().optional().catch(undefined),
});

export const Route = createFileRoute('/_app/admin/access-control')({
  staticData: { crumbs: ['Administration', 'Access control'], readOnly: { read: 'grants:read', write: 'grants:write' } },
  validateSearch: search,
  beforeLoad: guard(['grants:read']),
  errorComponent: AreaError,
  component: AccessControlPage,
});

function AccessControlPage() {
  const me = useMe();
  const s = Route.useSearch();
  useFilterNames([s.server]);
  const navigate = useNavigate({ from: Route.fullPath });
  const wide = useMinWidth(1024);
  const [adding, setAdding] = useState(false);
  const canWrite = can(me, 'grants:write');
  const set = (p: Partial<z.infer<typeof search>>) => void navigate({ search: (prev) => ({ ...prev, ...p }) });
  // The matrix needs ≥ 1024 px; smaller screens fall back to the list view (W4 acceptance).
  const view = s.view === 'matrix' && wide ? 'matrix' : 'list';
  const server = s.server ? { id: s.server, name: filterLabels.get(s.server) ?? s.server.slice(0, 8) } : null;

  return (
    <Page>
      <PageHeader
        title="Access control"
        description={
          <>
            Grants are subject × server or tool × allow / deny. <span className="font-medium text-foreground">Deny always wins.</span>
          </>
        }
        actions={
          <>
            <CheckAccessSheet initial={s.check && s.subjectId ? { type: s.check, id: s.subjectId } : undefined} />
            {canWrite ? (
              <Button onClick={() => setAdding(true)}>
                <PlusIcon /> Add grant
              </Button>
            ) : null}
          </>
        }
      />
      <Toolbar>
        {wide ? (
          <Segmented<'list' | 'matrix'>
            label="View"
            value={view}
            onChange={(v) => set({ view: v === 'list' ? undefined : v })}
            options={[
              { value: 'list', label: 'List' },
              { value: 'matrix', label: 'Matrix' },
            ]}
          />
        ) : s.view === 'matrix' ? (
          <p className="text-[13px] text-muted-foreground">The matrix view needs a screen at least 1024 px wide; showing the list.</p>
        ) : null}
        {view === 'list' ? (
          <>
            <EntityPicker
              chip
              label="Server"
              value={server}
              onChange={(o) => {
                if (o) filterLabels.set(o.id, o.name);
                set({ server: o?.id });
              }}
              search={pickerSearch.servers}
              queryKey={['servers']}
            />
            <Select value={s.subjectType ?? 'any'} onValueChange={(v) => set({ subjectType: v === 'any' ? undefined : (v as SubjectType) })} items={[{ value: 'any', label: 'All subjects' }, { value: 'user', label: 'Users' }, { value: 'group', label: 'Groups' }, { value: 'agent', label: 'Agents' }]}>
              <SelectTrigger aria-label="Subject type" className="h-8 min-w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">All subjects</SelectItem>
                <SelectItem value="user">Users</SelectItem>
                <SelectItem value="group">Groups</SelectItem>
                <SelectItem value="agent">Agents</SelectItem>
              </SelectContent>
            </Select>
            <Select value={s.effect ?? 'any'} onValueChange={(v) => set({ effect: v === 'any' ? undefined : (v as GrantEffect) })} items={[{ value: 'any', label: 'Allow and deny' }, { value: 'allow', label: 'Allow' }, { value: 'deny', label: 'Deny' }]}>
              <SelectTrigger aria-label="Effect" className="h-8 min-w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Allow and deny</SelectItem>
                <SelectItem value="allow">Allow</SelectItem>
                <SelectItem value="deny">Deny</SelectItem>
              </SelectContent>
            </Select>
          </>
        ) : null}
      </Toolbar>
      {view === 'matrix' ? (
        <AccessMatrix
          server={server}
          readOnly={!canWrite}
          onServer={(o) => {
            if (o) filterLabels.set(o.id, o.name);
            set({ server: o?.id });
          }}
        />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <GrantsTable filter={{ serverId: s.server, subjectType: s.subjectType, effect: s.effect }} canWrite={canWrite} />
        </div>
      )}
      <AddGrantDialog open={adding} onOpenChange={setAdding} initialServer={server} />
    </Page>
  );
}
