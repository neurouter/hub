import { createFileRoute, useNavigate } from '@tanstack/react-router';
import * as z from 'zod';
import { ToolListStatus } from '@neurouter/shared';
import { AreaError, guard } from '@/app/route-guards';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EntityPicker } from '@/components/filters/entity-picker';
import { SearchInput } from '@/components/filters/search-input';
import { PageHeader } from '@/components/layout/page-header';
import { Page, Toolbar } from '@/components/layout/section';
import { filterLabels } from '@/features/audit/search';
import { useFilterNames } from '@/features/lookup/names';
import { pickerSearch } from '@/features/pickers';
import { ToolsTable } from '@/features/tools/tools-table';

const search = z.object({
  q: z.string().max(200).optional().catch(undefined),
  status: ToolListStatus.optional().catch(undefined),
  server: z.string().optional().catch(undefined),
});

export const Route = createFileRoute('/_app/admin/tools/')({
  staticData: { crumbs: ['Administration', 'Tools'], readOnly: { read: 'tools:read', write: 'tools:write' } },
  validateSearch: search,
  beforeLoad: guard(['tools:read']),
  errorComponent: AreaError,
  component: ToolsPage,
});

const STATUS_ITEMS = [
  { value: 'any', label: 'Any status' },
  { value: 'pending_review', label: 'Pending review' },
  { value: 'enabled', label: 'Enabled' },
  { value: 'disabled', label: 'Disabled' },
];

function ToolsPage() {
  const s = Route.useSearch();
  useFilterNames([s.server]);
  const navigate = useNavigate({ from: Route.fullPath });
  const set = (p: Partial<z.infer<typeof search>>) => void navigate({ search: (prev) => ({ ...prev, ...p }) });
  return (
    <Page>
      <PageHeader title="Tools" description="Every tool discovered on your servers. New and changed tools stay disabled until reviewed." />
      <Toolbar>
        <SearchInput label="Search tools" value={s.q} onChange={(q) => set({ q })} />
        <EntityPicker
          chip
          label="Server"
          value={s.server ? { id: s.server, name: filterLabels.get(s.server) ?? s.server.slice(0, 8) } : null}
          onChange={(o) => {
            if (o) filterLabels.set(o.id, o.name);
            set({ server: o?.id });
          }}
          search={pickerSearch.servers}
          queryKey={['servers']}
        />
        <Select value={s.status ?? 'any'} onValueChange={(v) => set({ status: v === 'any' ? undefined : (v as z.infer<typeof ToolListStatus>) })} items={STATUS_ITEMS}>
          <SelectTrigger aria-label="Status" className="h-8 min-w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_ITEMS.map((i) => (
              <SelectItem key={i.value} value={i.value}>
                {i.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Toolbar>
      <ToolsTable filter={{ q: s.q, status: s.status, ...(s.server ? { serverId: [s.server] } : {}) }} />
    </Page>
  );
}
