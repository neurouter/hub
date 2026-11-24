import { DownloadIcon } from 'lucide-react';
import { AUDIT_EXPORT_ROW_CAP } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { auditExportUrl } from '@/lib/download';
import { formatCompact } from '@/lib/format';
import type { AuditApiFilters } from './search';

/** Export (§5.3): browser-native download links that carry the active filters. */
export function ExportMenu({ filters }: { filters: AuditApiFilters }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
        <DownloadIcon /> Export
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Export current filters</DropdownMenuLabel>
          <DropdownMenuItem render={<a href={auditExportUrl(filters, 'csv')} download />}>CSV</DropdownMenuItem>
          <DropdownMenuItem render={<a href={auditExportUrl(filters, 'json')} download />}>JSON (NDJSON)</DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <p className="px-2 py-1.5 text-xs text-muted-foreground">Exports up to {formatCompact(AUDIT_EXPORT_ROW_CAP)} rows; narrow the range for more. Exports are audited.</p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
