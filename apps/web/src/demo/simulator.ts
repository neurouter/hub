import type { QueryClient } from '@tanstack/react-query';
import type { Approval, AuditEvent } from '@neurouter/shared';
import { approvalKeys } from '@/features/approvals/model';
import { auditKeys } from '@/features/audit/queries';
import { metricsKeys } from '@/features/observability/queries';
import { sessionKeys } from '@/features/sessions/queries';
import type { EventSourceLike, LiveTransport } from '@/lib/live';
import * as D from '@/mocks/demo-data';

/**
 * Demo site only (VITE_DEMO=true): makes the mock dataset look like a busy gateway.
 *
 * - Every few seconds an agent makes a tool call: a new audit event, live metrics and the active
 *   session move on, and the audit, metrics and sessions queries refetch.
 * - Sensitive tools open an approval, delivered through a fake approvals SSE stream (the console's
 *   real live channel). A teammate approves or denies it a little later, or it times out.
 *
 * Everything lives in this tab's memory; a reload starts over.
 */

type Person = { id: string; name: string };
type Client = { name: string; version: string | null } | null;

interface Actor {
  person: Person;
  agent: (typeof D.AGENTS)[number];
  client: Client;
}

const CLAUDE_CODE: Client = { name: 'Claude Code', version: '2.4' };
const CURSOR: Client = { name: 'Cursor', version: '1.9' };

const ACTORS = {
  priya: { person: D.PEOPLE.priya, agent: D.AGENTS[4]!, client: CLAUDE_CODE },
  dana: { person: D.PEOPLE.dana, agent: D.AGENTS[1]!, client: CLAUDE_CODE },
  sam: { person: D.PEOPLE.sam, agent: D.AGENTS[5]!, client: CURSOR },
  releaseBot: { person: D.PEOPLE.dana, agent: D.AGENTS[0]!, client: null },
  triage: { person: D.PEOPLE.marco, agent: D.AGENTS[2]!, client: null },
} satisfies Record<string, Actor>;

interface Scenario {
  weight: number;
  actor: Actor;
  tool: string;
  outcome:
    | { kind: 'ok'; latency: [number, number] }
    | { kind: 'error'; status: AuditEvent['status']; latency: [number, number]; message: string }
    | { kind: 'blocked'; decision: AuditEvent['decision']; reason: string }
    | { kind: 'approval'; input: Approval['inputParams'] };
}

const SCENARIOS: Scenario[] = [
  { weight: 9, actor: ACTORS.priya, tool: 'internal-docs__get_page', outcome: { kind: 'ok', latency: [60, 190] } },
  { weight: 8, actor: ACTORS.dana, tool: 'github__search_code', outcome: { kind: 'ok', latency: [180, 420] } },
  { weight: 7, actor: ACTORS.priya, tool: 'github__get_pull_request', outcome: { kind: 'ok', latency: [140, 360] } },
  { weight: 6, actor: ACTORS.triage, tool: 'jira__search_issues', outcome: { kind: 'ok', latency: [300, 1400] } },
  { weight: 4, actor: ACTORS.releaseBot, tool: 'github__list_workflow_runs', outcome: { kind: 'ok', latency: [220, 640] } },
  { weight: 4, actor: ACTORS.sam, tool: 'postgres-analytics__describe_table', outcome: { kind: 'ok', latency: [90, 300] } },
  { weight: 3, actor: ACTORS.triage, tool: 'slack__search_messages', outcome: { kind: 'ok', latency: [200, 700] } },
  { weight: 3, actor: ACTORS.triage, tool: 'jira__create_issue', outcome: { kind: 'ok', latency: [400, 900] } },
  { weight: 2, actor: ACTORS.dana, tool: 'github__create_issue', outcome: { kind: 'ok', latency: [380, 820] } },
  { weight: 1, actor: ACTORS.triage, tool: 'jira__search_issues', outcome: { kind: 'error', status: 'upstream_error', latency: [1500, 2400], message: 'Upstream 503: Jira is temporarily unavailable' } },
  { weight: 1, actor: ACTORS.priya, tool: 'github__get_pull_request', outcome: { kind: 'error', status: 'tool_error', latency: [80, 160], message: 'Tool error: pull request #9921 not found' } },
  { weight: 2, actor: ACTORS.sam, tool: 'github__delete_branch', outcome: { kind: 'blocked', decision: 'denied_acl', reason: 'Denied by group:contractors deny on github__delete_branch' } },
  { weight: 2, actor: ACTORS.triage, tool: 'github__search_code', outcome: { kind: 'blocked', decision: 'denied_rate_limit', reason: 'Rate limited: agent 60/min' } },
  { weight: 1, actor: ACTORS.priya, tool: 'internal-docs__search_docs', outcome: { kind: 'blocked', decision: 'denied_disabled', reason: 'Tool disabled: definition pending review' } },
  {
    weight: 2,
    actor: ACTORS.sam,
    tool: 'postgres-analytics__run_query',
    outcome: {
      kind: 'approval',
      input: {
        sql: "SELECT date_trunc('week', created_at) AS week, sum(amount)\n  FROM orders_mart\n WHERE region = 'EMEA'\n GROUP BY 1 ORDER BY 1 DESC LIMIT 12",
        connection_string: { $redacted: 'secret-values' },
        timeout_ms: 30000,
      },
    },
  },
  { weight: 1, actor: ACTORS.releaseBot, tool: 'github__merge_pull_request', outcome: { kind: 'approval', input: { repo: 'acme-corp/payments-api', pull_number: 4190, merge_method: 'squash', commit_title: 'Release 2026.11.25 (#4190)' } } },
  { weight: 1, actor: ACTORS.triage, tool: 'slack__post_message', outcome: { kind: 'approval', input: { channel: '#support-escalations', text: 'Triage summary: 5 new tickets, 1 P1 (SUP-3381) assigned to on-call.', api_token: { $redacted: 'token-keys' } } } },
];

const REVIEWERS: Person[] = [D.PEOPLE.dana, D.PEOPLE.marco];
const APPROVAL_TIMEOUT_SEC = 300;
const MAX_PENDING = 6;
const MAX_EVENTS = 400;

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;
function weighted(xs: Scenario[]): Scenario {
  let r = Math.random() * xs.reduce((n, x) => n + x.weight, 0);
  for (const x of xs) if ((r -= x.weight) < 0) return x;
  return xs[0]!;
}
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');

/* ------------------------------------------------------------ fake approvals SSE */

class DemoEventSource implements EventSourceLike {
  readyState = 0;
  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  private readonly listeners = new Map<string, Set<(e: MessageEvent) => void>>();

  constructor(private readonly hub: Set<DemoEventSource>) {
    hub.add(this);
    setTimeout(() => {
      if (this.readyState === 2) return;
      this.readyState = 1;
      this.onopen?.(new Event('open'));
    }, 50);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  close() {
    this.readyState = 2;
    this.hub.delete(this);
  }
  emit(type: string, data: unknown, lastEventId: string) {
    const e = new MessageEvent(type, { data: JSON.stringify(data), lastEventId });
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
}

/* ------------------------------------------------------------------ simulator */

export function startDemoSimulator(qc: QueryClient, transport: LiveTransport): () => void {
  const sources = new Set<DemoEventSource>();
  transport.create = () => new DemoEventSource(sources);
  const broadcast = (type: string, a: Approval) => {
    for (const s of sources) s.emit(type, a, `${Date.parse(a.decidedAt ?? a.createdAt)}:${a.id}`);
  };

  let seq = D.AUDIT_EVENTS.reduce((m, e) => Math.max(m, e.seq), 0);
  const timers: ReturnType<typeof setTimeout>[] = [];
  let stopped = false;

  function record(actor: Actor, toolQn: string, fields: Pick<AuditEvent, 'decision' | 'decisionReason' | 'status' | 'latencyMs' | 'errorMessage'>): void {
    const tool = D.TOOL_BY_QN[toolQn];
    if (!tool) return;
    seq += 1 + Math.floor(Math.random() * 3); // other replicas write too
    const session = D.SESSIONS[0]!;
    const inSession = actor.agent.id === session.agent.id;
    D.AUDIT_EVENTS.unshift({
      id: crypto.randomUUID(),
      seq,
      ts: new Date().toISOString(),
      kind: 'tool_call',
      user: { id: actor.person.id, name: actor.person.name },
      agent: { id: actor.agent.id, name: actor.agent.name },
      client: actor.client,
      server: tool.server,
      tool: { name: tool.name, qualifiedName: tool.qualifiedName },
      ...fields,
      traceId: hex(32),
      sessionId: inSession ? session.id : null,
      adminAction: null,
    });
    D.AUDIT_EVENTS.length = Math.min(D.AUDIT_EVENTS.length, MAX_EVENTS);
    D.LIVE.calls += 1;
    if (fields.status === 'blocked') D.LIVE.blocked += 1;
    if (inSession) {
      session.lastActivityAt = new Date().toISOString();
      session.callCount += 1;
      if (fields.status === 'blocked') session.blockedCount += 1;
      else if (fields.status !== 'ok') session.errorCount += 1;
    }
    void qc.invalidateQueries({ queryKey: auditKeys.all });
    void qc.invalidateQueries({ queryKey: sessionKeys.all });
  }

  function openApproval(s: Scenario & { outcome: { kind: 'approval' } }): void {
    if (D.APPROVALS.length >= MAX_PENDING) return;
    const tool = D.TOOL_BY_QN[s.tool];
    if (!tool) return;
    const now = Date.now();
    const a: Approval = {
      id: crypto.randomUUID(),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + APPROVAL_TIMEOUT_SEC * 1000).toISOString(),
      timeoutSec: APPROVAL_TIMEOUT_SEC,
      user: { id: s.actor.person.id, name: s.actor.person.name },
      agent: { id: s.actor.agent.id, name: s.actor.agent.name },
      client: s.actor.client,
      authMethod: s.actor.client ? 'oauth' : 'api_key',
      server: tool.server,
      tool: { name: tool.name, qualifiedName: tool.qualifiedName },
      inputParams: s.outcome.input,
      argumentsHash: `sha256:${hex(64)}`,
      status: 'pending',
      decidedBy: null,
      decidedAt: null,
      reason: null,
      actions: ['approve', 'deny'],
    };
    D.APPROVALS.unshift(a);
    record(s.actor, s.tool, { decision: 'approval_pending', decisionReason: 'Held for human approval', status: 'blocked', latencyMs: null, errorMessage: null });
    broadcast('approval.created', a);
    // a reviewer usually answers within a minute
    later(rand(25_000, 70_000), () => resolveApproval(a.id, s.actor));
  }

  function resolveApproval(id: string, actor?: Actor): void {
    const i = D.APPROVALS.findIndex((x) => x.id === id);
    if (i < 0) return;
    const a = D.APPROVALS[i]!;
    const expired = Date.parse(a.expiresAt) <= Date.now();
    const approve = !expired && Math.random() < 0.8;
    const by = pick(REVIEWERS);
    const resolved: Approval = {
      ...a,
      status: expired ? 'expired' : approve ? 'approved' : 'denied',
      decidedBy: expired ? null : { id: by.id, name: by.name },
      decidedAt: new Date().toISOString(),
      reason: expired || approve ? null : 'Not during the change freeze.',
      actions: [],
    };
    D.APPROVALS.splice(i, 1);
    D.RESOLVED_APPROVALS.unshift(resolved);
    broadcast(expired ? 'approval.expired' : 'approval.resolved', resolved);
    const who = actor ?? { person: a.user, agent: D.AGENTS.find((g) => g.id === a.agent.id) ?? D.AGENTS[0]!, client: a.client };
    const waited = Math.round((Date.now() - Date.parse(a.createdAt)) / 1000);
    if (expired) {
      record(who, a.tool.qualifiedName, { decision: 'approval_timeout', decisionReason: `No decision within ${Math.round(a.timeoutSec / 60)} min`, status: 'blocked', latencyMs: a.timeoutSec * 1000, errorMessage: `No decision within ${Math.round(a.timeoutSec / 60)} min` });
    } else if (approve) {
      record(who, a.tool.qualifiedName, { decision: 'approved', decisionReason: `Approved by ${by.name} after ${waited} s`, status: 'ok', latencyMs: Math.round(waited * 1000 + rand(200, 900)), errorMessage: null });
    } else {
      record(who, a.tool.qualifiedName, { decision: 'approval_denied', decisionReason: `Denied by ${by.name}: not during the change freeze`, status: 'blocked', latencyMs: waited * 1000, errorMessage: `Denied by ${by.name}: not during the change freeze` });
    }
  }

  function later(ms: number, fn: () => void): void {
    timers.push(
      setTimeout(() => {
        if (!stopped) fn();
      }, ms),
    );
  }

  function tick(): void {
    const s = weighted(SCENARIOS);
    const o = s.outcome;
    if (o.kind === 'ok') {
      record(s.actor, s.tool, { decision: 'allowed', decisionReason: null, status: 'ok', latencyMs: Math.round(rand(...o.latency)), errorMessage: null });
    } else if (o.kind === 'error') {
      record(s.actor, s.tool, { decision: 'allowed', decisionReason: null, status: o.status, latencyMs: Math.round(rand(...o.latency)), errorMessage: o.message });
    } else if (o.kind === 'blocked') {
      record(s.actor, s.tool, { decision: o.decision, decisionReason: o.reason, status: 'blocked', latencyMs: Math.round(rand(1, 4)), errorMessage: o.reason });
    } else {
      openApproval({ ...s, outcome: o });
    }
    later(rand(1800, 4200), tick);
  }

  // the seeded approvals expire on their own clocks: settle each one when it is due
  for (const a of [...D.APPROVALS]) later(Math.max(1000, Date.parse(a.expiresAt) - Date.now() - rand(5_000, 12_000)), () => resolveApproval(a.id));

  // KPIs and charts refresh on a calmer beat than the audit log
  const metricsTimer = setInterval(() => void qc.invalidateQueries({ queryKey: metricsKeys.all }), 10_000);
  // the seeded approvals were created before the stream: make sure the list is current once
  void qc.invalidateQueries({ queryKey: approvalKeys.all });
  later(1500, tick);

  return () => {
    stopped = true;
    clearInterval(metricsTimer);
    for (const t of timers) clearTimeout(t);
    for (const s of sources) s.close();
  };
}
