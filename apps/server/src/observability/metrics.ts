import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import { LATENCY_BUCKETS_MS } from '../lib/histogram.js';
import type { AuditLogTable } from '../db/schema.js';

/** Same bounds as the rollup histogram (§10.1), in seconds, without +Inf (prom-client adds it). */
export const DURATION_BUCKETS_S = LATENCY_BUCKETS_MS.filter((b) => Number.isFinite(b)).map((b) => b / 1000);

/** Label names that must never appear on /metrics (user/agent ids belong in rollups). */
export const FORBIDDEN_LABELS = ['user', 'user_id', 'agent', 'agent_id', 'session', 'session_id'];

export type AuthFailureMethod = 'api_key' | 'oauth' | 'web';

/**
 * prom-client registry + facade (backend §10.4). Default process metrics are prefixed
 * `neurouter_`. Labels are low-cardinality only; the `tool` label can be dropped for very
 * large catalogs (`metricsToolLabel`).
 */
export class Metrics {
  readonly registry = new Registry();
  readonly mcpRequests: Counter<'method' | 'era' | 'outcome'>;
  readonly toolCalls: Counter<'server' | 'tool' | 'decision' | 'status'>;
  readonly toolCallDuration: Histogram<'server' | 'status'>;
  readonly upstreamDuration: Histogram<'server' | 'method'>;
  readonly upstreamUp: Gauge<'server'>;
  readonly circuitOpen: Gauge<'server'>;
  readonly rateLimited: Counter<'scope'>;
  readonly approvalsPending: Gauge;
  readonly approvalWait: Histogram<'outcome'>;
  readonly auditQueueDepth: Gauge;
  readonly auditDropped: Counter;
  readonly auditFlush: Histogram;
  readonly embeddingQueueDepth: Gauge<'kind'>;
  readonly embeddingSeconds: Histogram<'kind'>;
  readonly authFailures: Counter<'method' | 'reason'>;
  toolLabel = true;
  /** Refreshes scrape-time gauges (upstream health, pending approvals, queue depths). */
  beforeRender: (() => Promise<void>) | null = null;

  constructor(opts: { defaultMetrics?: boolean } = {}) {
    const registers = [this.registry];
    if (opts.defaultMetrics ?? true) collectDefaultMetrics({ register: this.registry, prefix: 'neurouter_' });
    this.mcpRequests = new Counter({ name: 'neurouter_mcp_requests_total', help: 'MCP requests by method, client era and outcome', labelNames: ['method', 'era', 'outcome'], registers });
    this.toolCalls = new Counter({ name: 'neurouter_tool_calls_total', help: 'Tool calls by server, tool, decision and status', labelNames: ['server', 'tool', 'decision', 'status'], registers });
    this.toolCallDuration = new Histogram({ name: 'neurouter_tool_call_duration_seconds', help: 'End-to-end tool call latency', labelNames: ['server', 'status'], buckets: DURATION_BUCKETS_S, registers });
    this.upstreamDuration = new Histogram({ name: 'neurouter_upstream_request_duration_seconds', help: 'Upstream MCP request latency', labelNames: ['server', 'method'], buckets: DURATION_BUCKETS_S, registers });
    this.upstreamUp = new Gauge({ name: 'neurouter_upstream_up', help: '1 when the upstream server health is up or degraded', labelNames: ['server'], registers });
    this.circuitOpen = new Gauge({ name: 'neurouter_upstream_circuit_open', help: '1 while the upstream circuit breaker is open', labelNames: ['server'], registers });
    this.rateLimited = new Counter({ name: 'neurouter_rate_limited_total', help: 'Rate-limited tool calls by limit scope', labelNames: ['scope'], registers });
    this.approvalsPending = new Gauge({ name: 'neurouter_approvals_pending', help: 'Pending human approvals', registers });
    this.approvalWait = new Histogram({ name: 'neurouter_approval_wait_seconds', help: 'Time calls waited for a human decision', labelNames: ['outcome'], buckets: [1, 5, 15, 30, 60, 120, 300, 600, 900], registers });
    this.auditQueueDepth = new Gauge({ name: 'neurouter_audit_queue_depth', help: 'Audit events waiting to be written', registers });
    this.auditDropped = new Counter({ name: 'neurouter_audit_dropped_total', help: 'Audit events refused because the queue was full', registers });
    this.auditFlush = new Histogram({ name: 'neurouter_audit_flush_seconds', help: 'Audit batch write duration', buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5], registers });
    this.embeddingQueueDepth = new Gauge({ name: 'neurouter_embedding_queue_depth', help: 'Embedding requests waiting', labelNames: ['kind'], registers });
    this.embeddingSeconds = new Histogram({ name: 'neurouter_embedding_seconds', help: 'Embedding latency', labelNames: ['kind'], buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5], registers });
    this.authFailures = new Counter({ name: 'neurouter_auth_failures_total', help: 'Authentication failures by method and reason', labelNames: ['method', 'reason'], registers });
  }

  /** Server label from an exposed tool name (`<slug>__<tool>`): bounded by the catalog. */
  static serverLabel(toolName: string | null): string {
    if (!toolName) return 'none';
    const i = toolName.indexOf('__');
    return i > 0 ? toolName.slice(0, i) : 'unknown';
  }

  /** Counts committed audit rows (called by the audit writer after each flush). */
  observeAudit(rows: readonly Pick<AuditLogTable, 'kind' | 'decision' | 'status' | 'tool_name' | 'client_era' | 'latency_ms' | 'upstream_latency_ms' | 'decision_reason'>[]): void {
    for (const r of rows) {
      const era = r.client_era === 'modern' || r.client_era === 'legacy' ? r.client_era : 'unknown';
      const outcome = r.status === 'blocked' ? 'denied' : r.status === 'ok' ? 'ok' : 'error';
      if (r.kind === 'tools_list') this.mcpRequests.inc({ method: 'tools/list', era, outcome });
      if (r.kind === 'tool_search') this.mcpRequests.inc({ method: 'tools/call', era, outcome });
      if (r.kind !== 'tool_call' || r.decision === 'approval_pending') continue;
      this.mcpRequests.inc({ method: 'tools/call', era, outcome });
      const server = Metrics.serverLabel(r.tool_name);
      this.toolCalls.inc({ server, tool: this.toolLabel ? (r.tool_name ?? 'unknown') : '', decision: r.decision, status: r.status });
      if (r.latency_ms !== null && r.status !== 'blocked') this.toolCallDuration.observe({ server, status: r.status }, Number(r.latency_ms) / 1000);
      if (r.upstream_latency_ms !== null) this.upstreamDuration.observe({ server, method: 'tools/call' }, Number(r.upstream_latency_ms) / 1000);
      if (r.decision === 'denied_rate_limit') this.rateLimited.inc({ scope: r.decision_reason ?? 'unknown' });
    }
  }

  authFailure(method: AuthFailureMethod, reason: string): void {
    this.authFailures.inc({ method, reason: reason.slice(0, 40) });
  }

  async render(): Promise<{ contentType: string; body: string }> {
    if (this.beforeRender) await this.beforeRender().catch(() => {});
    return { contentType: this.registry.contentType, body: await this.registry.metrics() };
  }
}
