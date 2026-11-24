import { useMemo, type ReactNode } from 'react';
import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon } from 'lucide-react';
import { createColumnHelper, rowSelectionFeature, tableFeatures, useTable, type RowData, type RowSelectionState } from '@tanstack/react-table';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/feedback/states';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';

/**
 * Column spec for `DataTable`. Pages describe columns with plain render functions; the table
 * wraps TanStack Table v9 (`useTable` + `tableFeatures`) so pages never touch the v9 API directly
 * (frontend R2). Server-side sorting/pagination: the table renders exactly the rows it is given.
 */
export interface ColumnSpec<T> {
  id: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  align?: 'right';
  /** Mobile card list: 1 = title line, 2 = key/value line, absent = hidden on mobile. */
  priority?: 1 | 2;
  className?: string;
  /** Server-side sort field (`sort=<field>`); renders a sort button with aria-sort. */
  sortField?: string;
}

export interface SortState {
  field: string | undefined;
  order: 'asc' | 'desc' | undefined;
}

interface ColumnMeta {
  spec: ColumnSpec<unknown>;
}

const features = tableFeatures({ rowSelectionFeature, columnMeta: {} as ColumnMeta });

export interface DataTableProps<T extends RowData> {
  columns: ColumnSpec<T>[];
  rows: T[] | undefined;
  getRowId: (row: T) => string;
  /** Accessible name of the table. */
  label: string;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  empty?: ReactNode;
  /** Row selection (bulk actions). */
  selection?: { selected: RowSelectionState; onChange: (next: RowSelectionState) => void; rowLabel: (row: T) => string; canSelect?: (row: T) => boolean };
  /** Highlights the selected row (detail drawer open). */
  activeRowId?: string | null;
  onRowClick?: (row: T) => void;
  sort?: SortState & { onChange: (next: SortState) => void };
  /** Below md: `cards` (default) renders the mobile card list, `scroll` keeps the table with horizontal scroll. */
  mobile?: 'cards' | 'scroll';
  className?: string;
  /** Optional sticky first column (audit / ACL). */
  stickyFirst?: boolean;
  rowClassName?: (row: T) => string | undefined;
}

const EMPTY: never[] = [];

export function DataTable<T extends RowData>(props: DataTableProps<T>) {
  const { columns, rows, getRowId, label, loading, error, onRetry, empty, selection, onRowClick, sort, mobile = 'cards', className, stickyFirst, activeRowId, rowClassName } = props;
  const isMobile = useIsMobile();
  const helper = useMemo(() => createColumnHelper<typeof features, T>(), []);
  const defs = useMemo(() => {
    const out = [];
    if (selection) {
      out.push(
        helper.display({
          id: '__select',
          header: () => null,
          cell: () => null,
          meta: { spec: { id: '__select', header: null, cell: () => null } },
        }),
      );
    }
    for (const spec of columns) {
      out.push(
        helper.display({
          id: spec.id,
          header: () => spec.header,
          cell: (ctx) => spec.cell(ctx.row.original),
          meta: { spec: spec as ColumnSpec<unknown> },
        }),
      );
    }
    return out;
  }, [columns, helper, selection]);

  const data = rows ?? (EMPTY as T[]);
  const table = useTable({
    features,
    columns: defs,
    data,
    getRowId: (r: T) => getRowId(r),
    enableRowSelection: selection ? (row) => (selection.canSelect ? selection.canSelect(row.original) : true) : false,
    state: { rowSelection: selection?.selected ?? {} },
    onRowSelectionChange: (updater) => {
      if (!selection) return;
      const next = typeof updater === 'function' ? updater(selection.selected) : updater;
      selection.onChange(next);
    },
  });

  if (error && !rows) return <ErrorState error={error} {...(onRetry ? { onRetry } : {})} />;

  const tableRows = table.getRowModel().rows;
  const showSkeleton = loading && !rows;
  const isEmpty = !showSkeleton && tableRows.length === 0;

  if (isMobile && mobile === 'cards') {
    return (
      <ul aria-label={label} className={cn('flex flex-col gap-2', className)}>
        {showSkeleton
          ? Array.from({ length: 4 }, (_, i) => (
              <li key={i}>
                <Skeleton className="h-20 w-full" />
              </li>
            ))
          : null}
        {isEmpty ? <li>{empty}</li> : null}
        {tableRows.map((row) => {
          const primary = columns.filter((c) => c.priority === 1);
          const secondary = columns.filter((c) => c.priority === 2);
          return (
            <li
              key={row.id}
              className={cn('flex flex-col gap-1.5 rounded-xl border bg-card p-3', onRowClick && 'cursor-pointer')}
              onClick={onRowClick ? () => onRowClick(row.original) : undefined}
            >
              <div className="flex flex-wrap items-center gap-2">
                {primary.map((c) => (
                  <div key={c.id} className="min-w-0">
                    {c.cell(row.original)}
                  </div>
                ))}
              </div>
              {secondary.length ? (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
                  {secondary.map((c) => (
                    <div key={c.id} className="contents">
                      <dt className="text-muted-foreground">{c.header}</dt>
                      <dd className="min-w-0">{c.cell(row.original)}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </li>
          );
        })}
      </ul>
    );
  }

  const allSelected = selection ? table.getIsAllRowsSelected() : false;
  const someSelected = selection ? table.getIsSomeRowsSelected() : false;

  return (
    <div className={cn('relative w-full overflow-x-auto rounded-xl border bg-card', className)}>
      <table aria-label={label} aria-busy={loading ? true : undefined} className="w-full caption-bottom text-sm">
        <thead>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id} className="border-b">
              {group.headers.map((header, i) => {
                const spec = (header.column.columnDef.meta as ColumnMeta | undefined)?.spec;
                if (header.column.id === '__select') {
                  return (
                    <th key={header.id} scope="col" className="w-10 px-3 py-2.5">
                      <Checkbox
                        aria-label="Select all rows"
                        checked={allSelected}
                        indeterminate={someSelected && !allSelected}
                        onCheckedChange={(v) => table.toggleAllRowsSelected(Boolean(v))}
                      />
                    </th>
                  );
                }
                const sortable = !!(sort && spec?.sortField);
                const active = sortable && sort?.field === spec?.sortField;
                return (
                  <th
                    key={header.id}
                    scope="col"
                    aria-sort={active ? (sort?.order === 'asc' ? 'ascending' : 'descending') : undefined}
                    className={cn(
                      'h-10 px-3 text-left align-middle in-data-[density=compact]:h-8 text-[12.5px] font-medium whitespace-nowrap text-muted-foreground',
                      spec?.align === 'right' && 'text-right',
                      stickyFirst && i === 0 && 'sticky left-0 z-10 bg-card',
                    )}
                  >
                    {sortable && spec?.sortField ? (
                      <button
                        type="button"
                        className="-mx-1 inline-flex items-center gap-1 rounded px-1 hover:text-foreground"
                        onClick={() =>
                          sort?.onChange({ field: spec.sortField, order: active && sort.order === 'desc' ? 'asc' : 'desc' })
                        }
                      >
                        <table.FlexRender header={header} />
                        {active ? sort?.order === 'asc' ? <ArrowUpIcon className="size-3.5" /> : <ArrowDownIcon className="size-3.5" /> : <ChevronsUpDownIcon className="size-3.5 opacity-50" />}
                      </button>
                    ) : (
                      <table.FlexRender header={header} />
                    )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {showSkeleton
            ? Array.from({ length: 5 }, (_, i) => (
                <tr key={i} className="border-b last:border-0">
                  {defs.map((d, j) => (
                    <td key={`${i}-${d.id ?? j}`} className="px-3 py-3">
                      <Skeleton className="h-4 w-full max-w-40" />
                    </td>
                  ))}
                </tr>
              ))
            : null}
          {isEmpty ? (
            <tr>
              <td colSpan={defs.length} className="p-4">
                {empty}
              </td>
            </tr>
          ) : null}
          {tableRows.map((row) => (
            <tr
              key={row.id}
              data-state={row.getIsSelected() ? 'selected' : undefined}
              aria-selected={activeRowId === row.id ? true : undefined}
              className={cn(
                'border-b transition-colors last:border-0 hover:bg-muted/50 data-[state=selected]:bg-muted',
                activeRowId === row.id && 'bg-muted shadow-[inset_3px_0_0_var(--foreground)]',
                onRowClick && 'cursor-pointer',
                rowClassName?.(row.original),
              )}
              onClick={onRowClick ? (e) => {
                if ((e.target as HTMLElement).closest('button,a,input,label,[role=checkbox],[role=switch]')) return;
                onRowClick(row.original);
              } : undefined}
            >
              {row.getAllCells().map((cell, i) => {
                const spec = (cell.column.columnDef.meta as ColumnMeta | undefined)?.spec;
                if (cell.column.id === '__select') {
                  return (
                    <td key={cell.id} className="w-10 px-3 py-2.5 in-data-[density=compact]:py-1">
                      <Checkbox
                        aria-label={`Select ${selection?.rowLabel(row.original) ?? row.id}`}
                        checked={row.getIsSelected()}
                        disabled={!row.getCanSelect()}
                        onCheckedChange={(v) => row.toggleSelected(Boolean(v))}
                      />
                    </td>
                  );
                }
                return (
                  <td
                    key={cell.id}
                    className={cn(
                      'px-3 py-2.5 align-middle in-data-[density=compact]:py-1',
                      spec?.align === 'right' && 'text-right tabular-nums',
                      stickyFirst && i === 0 && 'sticky left-0 z-10 bg-card',
                      spec?.className,
                    )}
                  >
                    <table.FlexRender cell={cell} />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
