import type { ReactNode } from 'react';
import { ChevronDownIcon, SlidersHorizontalIcon } from 'lucide-react';
import { can, type AuditDecision, type AuditStatus, type Me } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { EntityPicker } from '@/components/filters/entity-picker';
import { SearchInput } from '@/components/filters/search-input';
import { Segmented } from '@/components/filters/segmented';
import { TimeRangePicker, type RangeChange } from '@/components/filters/time-range-picker';
import { useIsMobile } from '@/hooks/use-mobile';
import { RANGE_PRESETS, type ResolvedRange } from '@/lib/time-range';
import { cn } from '@/lib/utils';
import { pickerSearch } from '../pickers';
import { DECISION_FILTERS, STATUS_FILTERS, activeFilterCount, filterLabels, type AuditKindFilter, type AuditSearch } from './search';

type Patch = Partial<AuditSearch>;

function MultiChip<V extends string>({ label, groups, selected, onChange }: { label: string; groups: { label: string; values: V[] }[]; selected: V[] | undefined; onChange: (next: V[] | undefined) => void }) {
  const sel = new Set(selected ?? []);
  const activeLabels = groups.filter((g) => g.values.every((v) => sel.has(v))).map((g) => g.label);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] whitespace-nowrap hover:bg-muted',
              activeLabels.length ? 'border-foreground/40 bg-muted text-foreground' : 'border-dashed text-muted-foreground',
            )}
          />
        }
      >
        {label}
        {activeLabels.length ? (
          <>
            : <b className="max-w-40 truncate font-medium">{activeLabels.join(', ')}</b>
          </>
        ) : null}
        <ChevronDownIcon className="size-3.5 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          {groups.map((g) => {
            const on = g.values.every((v) => sel.has(v));
            return (
              <DropdownMenuCheckboxItem
                key={g.label}
                checked={on}
                onCheckedChange={(checked) => {
                  const next = new Set(sel);
                  for (const v of g.values) {
                    if (checked) next.add(v);
                    else next.delete(v);
                  }
                  onChange(next.size ? [...next] : undefined);
                }}
              >
                {g.label}
              </DropdownMenuCheckboxItem>
            );
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function label(id: string | undefined, fallback: (id: string) => string | undefined) {
  if (!id) return null;
  return { id, name: filterLabels.get(id) ?? fallback(id) ?? id.slice(0, 8) };
}

/**
 * Audit toolbar (§5.3): time range, debounced search (400 ms), User/Agent/Server/Tool pickers,
 * Decision/Status multi-selects, Kind segmented control and Reset. On mobile the filters move
 * into a "Filters (n)" sheet.
 */
export function AuditFilters({ me, search, range, onChange, onRange, lookup, extra }: { me: Me; search: AuditSearch; range: ResolvedRange; onChange: (p: Patch) => void; onRange: (r: RangeChange) => void; lookup: (id: string) => string | undefined; extra?: ReactNode }) {
  const isMobile = useIsMobile();
  const pick = (key: 'userId' | 'agentId' | 'serverId' | 'toolId') => (o: { id: string; name: string } | null) => {
    if (o) filterLabels.set(o.id, o.name);
    onChange({ [key]: o?.id, event: undefined } as Patch);
  };
  const count = activeFilterCount(search);
  const filters = (
    <>
      {can(me, 'users:read') ? <EntityPicker chip label="User" value={label(search.userId, lookup)} onChange={pick('userId')} search={pickerSearch.users} queryKey={['users']} /> : null}
      <EntityPicker chip label="Agent" value={label(search.agentId, lookup)} onChange={pick('agentId')} search={pickerSearch.agents} queryKey={['agents']} />
      <EntityPicker chip label="Server" value={label(search.serverId, lookup)} onChange={pick('serverId')} search={pickerSearch.servers} queryKey={['servers']} />
      <EntityPicker chip label="Tool" value={label(search.toolId, lookup)} onChange={pick('toolId')} search={pickerSearch.tools(search.serverId)} queryKey={['tools', search.serverId ?? 'all']} />
      <MultiChip<AuditDecision> label="Decision" groups={DECISION_FILTERS} selected={search.decision} onChange={(decision) => onChange({ decision, event: undefined })} />
      <MultiChip<AuditStatus> label="Status" groups={STATUS_FILTERS.map((s) => ({ label: s.label, values: [s.value] }))} selected={search.status} onChange={(status) => onChange({ status, event: undefined })} />
      <Segmented<AuditKindFilter>
        label="Kind"
        size="sm"
        value={search.kind ?? 'tool_call'}
        onChange={(kind) => onChange({ kind: kind === 'tool_call' ? undefined : kind, event: undefined })}
        options={[
          { value: 'tool_call', label: 'Tool calls' },
          { value: 'admin', label: 'Admin changes' },
          { value: 'all', label: 'All' },
        ]}
      />
      {count ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange({ q: undefined, userId: undefined, agentId: undefined, serverId: undefined, toolId: undefined, sessionId: undefined, decision: undefined, status: undefined, kind: undefined, event: undefined })}
        >
          Reset filters
        </Button>
      ) : null}
    </>
  );
  return (
    <div className="flex flex-wrap items-center gap-2">
      <TimeRangePicker variant="button" value={range} presets={RANGE_PRESETS} onChange={onRange} />
      <SearchInput label="Search params and errors" placeholder="Search params, errors…" value={search.q} delayMs={400} onChange={(q) => onChange({ q, event: undefined })} />
      {isMobile ? (
        <Sheet>
          <SheetTrigger render={<Button variant="outline" className="h-9" />}>
            <SlidersHorizontalIcon /> Filters{count ? ` (${count})` : ''}
          </SheetTrigger>
          <SheetContent side="bottom" className="max-h-[85svh] overflow-y-auto">
            <SheetHeader>
              <SheetTitle>Filters</SheetTitle>
            </SheetHeader>
            <div className="flex flex-wrap gap-2 p-4 pt-0">{filters}</div>
          </SheetContent>
        </Sheet>
      ) : (
        filters
      )}
      {extra}
    </div>
  );
}
