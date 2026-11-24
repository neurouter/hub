import { describe, expect, it } from 'vitest';
import { FORBIDDEN_LABELS, Metrics } from './metrics.js';

const base = { kind: 'tool_call' as const, decision: 'allowed' as const, status: 'ok' as const, tool_name: 'github__create_issue', client_era: 'modern', latency_ms: 120, upstream_latency_ms: 100, decision_reason: null };

describe('Prometheus metrics', () => {
  it('counts committed audit rows with low-cardinality labels only (no user/agent ids)', async () => {
    const m = new Metrics({ defaultMetrics: true });
    m.observeAudit([base, { ...base, decision: 'denied_rate_limit', status: 'blocked', decision_reason: 'agent' }, { ...base, kind: 'tools_list', tool_name: null }]);
    m.authFailure('api_key', 'unknown_key');
    const { body, contentType } = await m.render();
    expect(contentType).toContain('text/plain');
    expect(body).toContain('neurouter_tool_calls_total{server="github",tool="github__create_issue",decision="allowed",status="ok"} 1');
    expect(body).toContain('neurouter_mcp_requests_total{method="tools/call",era="modern",outcome="denied"} 1');
    expect(body).toContain('neurouter_mcp_requests_total{method="tools/list",era="modern",outcome="ok"} 1');
    expect(body).toContain('neurouter_rate_limited_total{scope="agent"} 1');
    expect(body).toContain('neurouter_tool_call_duration_seconds_bucket{le="0.15",server="github",status="ok"} 1');
    expect(body).toContain('neurouter_auth_failures_total{method="api_key",reason="unknown_key"} 1');
    expect(body).toContain('neurouter_process_cpu_user_seconds_total');
    const labels = new Set([...body.matchAll(/[{,]([a-z_]+)="/g)].map((x) => x[1]!));
    for (const bad of FORBIDDEN_LABELS) expect(labels.has(bad)).toBe(false);
  });

  it('can drop the tool label and refreshes scrape-time gauges', async () => {
    const m = new Metrics({ defaultMetrics: false });
    m.toolLabel = false;
    m.beforeRender = async () => m.upstreamUp.set({ server: 'github' }, 1);
    m.observeAudit([base]);
    const { body } = await m.render();
    expect(body).toContain('tool=""');
    expect(body).toContain('neurouter_upstream_up{server="github"} 1');
    expect(Metrics.serverLabel('x')).toBe('unknown');
    expect(Metrics.serverLabel(null)).toBe('none');
  });
});
