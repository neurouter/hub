import { parseJsonColumn } from '../lib/json.js';
import type { AuditRow } from './types.js';

/** Full-row record for NDJSON export and archives (JSON columns parsed, ISO time added). */
export function exportRecord(r: AuditRow): Record<string, unknown> {
  return {
    seq: Number(r.seq),
    id: r.id,
    ts: new Date(Number(r.ts)).toISOString(),
    ts_ms: Number(r.ts),
    kind: r.kind,
    request_id: r.request_id,
    user_id: r.user_id,
    agent_id: r.agent_id,
    api_key_id: r.api_key_id,
    oauth_client_id: r.oauth_client_id,
    client_name: r.client_name,
    client_version: r.client_version,
    protocol_version: r.protocol_version,
    client_era: r.client_era,
    server_id: r.server_id,
    tool_id: r.tool_id,
    tool_name: r.tool_name,
    action: r.action,
    target_type: r.target_type,
    target_id: r.target_id,
    decision: r.decision,
    decision_reason: r.decision_reason,
    status: r.status,
    params_redacted: parseJsonColumn(r.params_redacted),
    changes: parseJsonColumn(r.changes),
    output_size: r.output_size === null ? null : Number(r.output_size),
    output_hash: r.output_hash,
    output_full: parseJsonColumn(r.output_full),
    latency_ms: r.latency_ms === null ? null : Number(r.latency_ms),
    upstream_latency_ms: r.upstream_latency_ms === null ? null : Number(r.upstream_latency_ms),
    error_code: r.error_code,
    error_message: r.error_message,
    trace_id: r.trace_id,
    span_id: r.span_id,
    session_id: r.session_id,
    ip: r.ip,
    user_agent: r.user_agent,
    prev_hash: r.prev_hash,
    hash: r.hash,
  };
}

export function ndjsonLine(r: AuditRow): string {
  return `${JSON.stringify(exportRecord(r))}\n`;
}

/** Fixed, documented CSV columns (README "Audit export"). Params are not included; use NDJSON. */
export const CSV_COLUMNS = [
  'seq', 'id', 'ts', 'kind', 'user_id', 'agent_id', 'client_name', 'client_version', 'server_id', 'tool_id', 'tool_name',
  'decision', 'decision_reason', 'status', 'latency_ms', 'upstream_latency_ms', 'error_code', 'error_message', 'trace_id',
  'session_id', 'action', 'target_type', 'target_id', 'output_size', 'output_hash', 'ip', 'prev_hash', 'hash',
] as const;

/**
 * RFC 4180 escaping plus spreadsheet formula-injection protection: cells starting with
 * `= + - @` (or tab/CR) are prefixed with a single quote.
 */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvHeader(): string {
  return `${CSV_COLUMNS.join(',')}\r\n`;
}

export function csvLine(r: AuditRow): string {
  const rec = exportRecord(r);
  return `${CSV_COLUMNS.map((c) => csvCell(rec[c])).join(',')}\r\n`;
}
