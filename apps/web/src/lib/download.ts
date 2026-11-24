import { api, buildPath, serializeQuery, type QueryValue } from '@neurouter/shared';

/**
 * Audit export link (frontend §5.3): a plain `<a href download>` so the browser streams the
 * file with the session cookie. The URL carries exactly the active filters plus `format`.
 */
export function auditExportUrl(filters: Record<string, QueryValue>, format: 'csv' | 'json'): string {
  return buildPath(api.audit.export.path) + serializeQuery({ ...filters, format });
}
