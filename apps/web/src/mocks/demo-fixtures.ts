import type { ContractFixtures } from './handlers';
import * as D from './demo-data';
import * as L from './library-data';

/**
 * Contract fixtures backed by the demo dataset: lists honour the common filters (q, serverId,
 * status, ...) so the dev mock mode behaves plausibly. Tests override single keys per case.
 */
type Ctx = { request: Request; params: Record<string, string | readonly string[] | undefined> };

const qs = (c: Ctx) => new URL(c.request.url).searchParams;
const param = (c: Ctx, k: string) => String(c.params[k] ?? '');
const page = <T>(items: T[]) => ({ items, nextCursor: null, totalEstimate: items.length });
const includes = (hay: string, q: string | null) => !q || hay.toLowerCase().includes(q.toLowerCase());
const notFound = () =>
  new Response(JSON.stringify({ type: 'https://neurouter.dev/problems/not-found', title: 'Not found', status: 404, code: 'not_found', requestId: 'msw' }), {
    status: 404,
    headers: { 'content-type': 'application/problem+json' },
  });
const body = async <T>(c: Ctx): Promise<T> => (await c.request.json()) as T;

export function demoFixtures(): ContractFixtures {
  return {
    /* users / groups */
    'users.list': (c: Ctx) => {
      const s = qs(c);
      return page(
        D.USERS.filter(
          (u) =>
            includes(`${u.name} ${u.email}`, s.get('q')) &&
            (!s.get('role') || u.roles.includes(s.get('role') as never)) &&
            (!s.get('status') || u.status === s.get('status')) &&
            (!s.get('groupId') || u.groups.some((g) => g.id === s.get('groupId'))),
        ),
      );
    },
    'users.get': (c: Ctx) => D.userDetail(param(c, 'id')) ?? notFound(),
    'users.update': async (c: Ctx) => ({ ...D.userDetail(param(c, 'id'))!, ...(await body<object>(c)) }),
    'groups.list': (c: Ctx) => page(D.GROUP_ROWS.filter((g) => includes(g.name, qs(c).get('q')))),
    'groups.get': (c: Ctx) => D.groupDetail(param(c, 'id')) ?? notFound(),
    'groups.create': async (c: Ctx) => ({ id: 'new-group', description: '', source: 'local', memberCount: 0, mappingCount: 0, grantCount: 0, ...(await body<object>(c)) }),
    'groups.update': async (c: Ctx) => ({ ...D.GROUP_ROWS.find((g) => g.id === param(c, 'id'))!, ...(await body<object>(c)) }),
    'groups.delete': null,
    'groups.members': (c: Ctx) => page(D.groupMembers(param(c, 'id'))),
    'groups.addMembers': async (c: Ctx) => ({ added: (await body<{ userIds: string[] }>(c)).userIds.length }),
    'groups.removeMember': null,
    'groups.claimMappings': (c: Ctx) => ({ items: D.CLAIM_MAPPINGS[param(c, 'id')] ?? [] }),
    'groups.createClaimMapping': async (c: Ctx) => ({ id: `cm-${Date.now()}`, lastSeenAt: null, ...(await body<object>(c)) }),
    'groups.deleteClaimMapping': null,

    /* agents */
    'agents.list': (c: Ctx) => {
      const s = qs(c);
      const owner = s.get('owner') ?? 'me';
      const rows = owner === 'all' ? D.AGENTS : owner === 'me' ? D.AGENTS.filter((a) => a.owner.id === D.PEOPLE.dana.id) : D.AGENTS.filter((a) => a.owner.id === owner);
      return page(rows.filter((a) => includes(`${a.name} ${a.owner.name}`, s.get('q'))));
    },
    'agents.get': (c: Ctx) => D.AGENTS.find((a) => a.id === param(c, 'id')) ?? notFound(),
    'agents.create': async (c: Ctx) => ({ ...D.AGENTS[0]!, id: `agent-${Date.now()}`, activeKeyCount: 0, lastUsedAt: null, description: '', ...(await body<object>(c)) }),
    'agents.update': async (c: Ctx) => ({ ...D.AGENTS.find((a) => a.id === param(c, 'id'))!, ...(await body<object>(c)) }),
    'agents.delete': null,
    'agents.keys': (c: Ctx) => ({ items: D.KEYS[param(c, 'id')] ?? [] }),
    'agents.createKey': async (c: Ctx) => {
      const b = await body<{ name: string; expiresAt: string | null }>(c);
      return {
        key: { id: `key-${Date.now()}`, name: b.name, prefix: 'nr_live_7f3K', status: 'active', createdAt: new Date().toISOString(), expiresAt: b.expiresAt, lastUsedAt: null, revokedAt: null },
        secret: 'nr_live_7f3K9qL2mX8vB4nR1tY6wZ0pD5sH2jE9cAu',
      };
    },
    'agents.revokeKey': (c: Ctx) => ({ ...(D.KEYS[param(c, 'id')] ?? []).find((k) => k.id === param(c, 'keyId'))!, status: 'revoked', revokedAt: new Date().toISOString() }),
    'agents.revokeAllKeys': (c: Ctx) => ({ revoked: (D.KEYS[param(c, 'id')] ?? []).filter((k) => k.status === 'active').length }),
    'agents.getScope': (c: Ctx) => D.SCOPES[param(c, 'id')] ?? { mode: 'inherit', serverIds: [], toolIds: [] },
    'agents.setScope': async (c: Ctx) => body(c),
    'agents.access': () => ({ servers: [] }),
    'oauth.myGrants': (c: Ctx) => ({ items: D.OAUTH_GRANTS.filter((g) => !qs(c).get('agentId') || g.agent.id === qs(c).get('agentId')) }),

    /* servers / tools */
    'servers.list': (c: Ctx) => {
      const s = qs(c);
      return page(D.SERVERS.filter((r) => includes(`${r.name} ${r.slug} ${r.url}`, s.get('q')) && (!s.get('status') || r.status === s.get('status'))));
    },
    'servers.get': (c: Ctx) => D.serverDetail(param(c, 'id')) ?? notFound(),
    'servers.update': async (c: Ctx) => ({ ...D.serverDetail(param(c, 'id'))!, ...(await body<object>(c)) }),
    'servers.delete': null,
    'servers.testConnection': { ok: true, protocolVersion: '2025-11-25', era: 'modern', serverInfo: { name: 'demo-mcp', version: '1.0.0' }, toolCount: 7, latencyMs: 184, authRequired: false, error: null },
    'servers.create': async (c: Ctx) => {
      const b = await body<{ name: string; slug: string }>(c);
      return { ...D.serverDetail(D.SERVER_IDS.docs)!, id: 'new-server', name: b.name, slug: b.slug, initialSync: { jobId: 'job-sync' } };
    },
    'servers.putCredentials': { hasSecret: true, secretUpdatedAt: new Date(D.NOW).toISOString() },
    'servers.sync': { jobId: 'job-sync' },
    'servers.quality': (c: Ctx) => L.demoServerQuality(param(c, 'id')) ?? notFound(),
    /* MCP server library */
    'library.status': () => L.LIBRARY_STATUS,
    'library.updateSettings': async (c: Ctx) => {
      const b = await body<{ enabled?: boolean; registryUrl?: string; githubToken?: string | null }>(c);
      return { ...L.LIBRARY_STATUS, ...(b.enabled !== undefined ? { enabled: b.enabled } : {}), ...(b.registryUrl ? { registryUrl: b.registryUrl } : {}), ...(b.githubToken !== undefined ? { hasGithubToken: b.githubToken !== null } : {}) };
    },
    'library.sync': { started: true },
    'library.list': (c: Ctx) => page(L.libraryList(qs(c))),
    'library.get': (c: Ctx) => L.LIBRARY.find((e) => e.id === param(c, 'id')) ?? notFound(),
    'library.check': (c: Ctx) => {
      const e = L.LIBRARY.find((x) => x.id === param(c, 'id'));
      return e ? { ...e, checkedAt: new Date(D.NOW).toISOString() } : notFound();
    },
    'library.update': async (c: Ctx) => {
      const e = L.LIBRARY.find((x) => x.id === param(c, 'id'));
      return e ? { ...e, hidden: (await body<{ hidden: boolean }>(c)).hidden } : notFound();
    },
    'servers.healthCheck': (c: Ctx) => D.SERVERS.find((s) => s.id === param(c, 'id'))?.health ?? notFound(),
    'servers.health': (c: Ctx) => D.healthHistory(param(c, 'id')),
    'servers.syncRuns': () => page([]),
    'jobs.get': (c: Ctx) => ({
      id: param(c, 'id'),
      kind: param(c, 'id').startsWith('job-verify') ? 'audit_verify' : 'tool_sync',
      status: 'succeeded',
      progress: 1,
      result: param(c, 'id').startsWith('job-verify')
        ? { ok: true, checked: 1_284_113, firstSeq: 1, lastSeq: 1_284_113, checkpointsVerified: 128, brokenAt: null, durationMs: 3200 }
        : { added: 2, changed: 1, removed: 0, unchanged: 21 },
      error: null,
      createdAt: new Date(D.NOW).toISOString(),
      finishedAt: new Date(D.NOW).toISOString(),
    }),
    'tools.list': (c: Ctx) => {
      const s = qs(c);
      const servers = s.getAll('serverId');
      const status = s.get('status');
      return page(
        D.TOOLS.filter(
          (t) =>
            includes(`${t.qualifiedName} ${t.description}`, s.get('q')) &&
            (servers.length === 0 || servers.includes(t.server.id)) &&
            (!status || (status === 'pending_review' ? t.reviewState === 'pending_review' : status === 'enabled' ? t.enabled : !t.enabled)),
        ),
      );
    },
    'tools.get': (c: Ctx) => D.toolDetail(param(c, 'id')) ?? notFound(),
    'tools.update': async (c: Ctx) => ({ ...D.toolDetail(param(c, 'id'))!, ...(await body<object>(c)) }),
    'tools.bulk': async (c: Ctx) => ({ updated: (await body<{ ids: string[] }>(c)).ids.length, skipped: [] }),
    'tools.definitionDiff': (c: Ctx) => {
      const t = D.TOOLS.find((x) => x.id === param(c, 'id'));
      if (!t) return notFound();
      if (t.qualifiedName === 'internal-docs__search_docs') return D.DOCS_DIFF;
      const d = D.toolDetail(t.id)!;
      const snap = { hash: d.pinnedHash ?? 'sha256:0', title: d.title, description: d.description, inputSchema: d.inputSchema, outputSchema: null, annotations: d.annotations };
      return { pinned: { ...snap, pinnedAt: d.pinnedAt!, pinnedBy: d.pinnedBy! }, current: { ...snap, detectedAt: d.pinnedAt! } };
    },
    'tools.approveDefinition': (c: Ctx) => ({ ...D.toolDetail(param(c, 'id'))!, reviewState: 'approved', hasPendingChange: false }),
    'tools.approveDefinitions': async (c: Ctx) => ({ approved: (await body<{ items: { id: string }[] }>(c)).items.map((i) => i.id), failed: [] }),
    'tools.rejectDefinition': (c: Ctx) => ({ ...D.toolDetail(param(c, 'id'))!, reviewState: 'rejected', hasPendingChange: false }),
    'tools.versions': () => page([]),

    /* grants & requests */
    'grants.list': (c: Ctx) => {
      const s = qs(c);
      return page(
        D.GRANTS.filter(
          (g) =>
            (!s.get('serverId') || g.target.server.id === s.get('serverId')) &&
            (!s.get('toolId') || g.target.id === s.get('toolId')) &&
            (!s.get('subjectType') || g.subject.type === s.get('subjectType')) &&
            (!s.get('subjectId') || g.subject.id === s.get('subjectId')) &&
            (!s.get('effect') || g.effect === s.get('effect')),
        ),
      );
    },
    'grants.create': async (c: Ctx) => {
      const b = await body<{ subject: { type: 'user'; id: string }; target: { type: 'server'; id: string }; effect: 'allow' }>(c);
      return { ...D.GRANTS[0]!, id: `grant-${Date.now()}`, subject: { ...b.subject, name: b.subject.id }, effect: b.effect };
    },
    'grants.delete': null,
    'grants.batch': async (c: Ctx) => {
      const b = await body<{ upserts: unknown[]; deletes: string[] }>(c);
      return { created: b.upserts.length, updated: 0, deleted: b.deletes.length };
    },
    'grants.effective': {
      decision: 'deny',
      reasons: [
        { grantId: D.GRANTS[1]!.id, subject: D.GRANTS[1]!.subject, target: D.GRANTS[1]!.target, effect: 'allow' },
        { grantId: D.GRANTS[3]!.id, subject: D.GRANTS[3]!.subject, target: D.GRANTS[3]!.target, effect: 'deny' },
      ],
    },
    'accessRequests.list': (c: Ctx) => {
      // same default as the server: pending only; `resolved` = everything decided
      const status = qs(c).get('status') ?? 'pending';
      return page(D.ACCESS_REQUESTS.filter((r) => (status === 'resolved' ? r.status !== 'pending' : r.status === status)));
    },
    'accessRequests.listMine': () => page(D.ACCESS_REQUESTS.filter((r) => r.requester.id === D.PEOPLE.sam.id)),
    'accessRequests.cancelMine': null,
    'accessRequests.create': async (c: Ctx) => {
      const b = await body<{ reason: string }>(c);
      return { ...D.ACCESS_REQUESTS[0]!, id: `ar-${Date.now()}`, reason: b.reason, status: 'pending', createdAt: new Date().toISOString() };
    },
    'accessRequests.approve': (c: Ctx) => ({ request: { ...D.ACCESS_REQUESTS.find((r) => r.id === param(c, 'id'))!, status: 'approved' }, grant: D.GRANTS[0]! }),
    'accessRequests.deny': async (c: Ctx) => ({ ...D.ACCESS_REQUESTS.find((r) => r.id === param(c, 'id'))!, status: 'denied', note: (await body<{ note: string }>(c)).note }),

    /* catalog */
    'catalog.servers': (c: Ctx) => {
      const s = qs(c);
      const tags = s.getAll('tag');
      const access = s.get('access');
      return page(
        D.catalogServers().filter(
          (x) =>
            includes(`${x.name} ${x.description}`, s.get('q')) &&
            (tags.length === 0 || tags.some((t) => x.tags.includes(t))) &&
            (!access || access === 'all' || (access === 'granted' ? x.access === 'granted' || x.access === 'partial' : x.access === 'none' || x.access === 'partial')),
        ),
      );
    },
    'catalog.server': (c: Ctx) => D.catalogServerDetail(param(c, 'id')) ?? notFound(),
    'catalog.tools': (c: Ctx) => {
      const s = qs(c);
      return page(
        D.catalogServers().flatMap((srv) =>
          (D.catalogServerDetail(srv.id)?.tools ?? [])
            .filter((t) => includes(`${t.qualifiedName} ${t.description}`, s.get('q')))
            .map((t) => ({ id: t.id, qualifiedName: t.qualifiedName, title: t.title, description: t.description, server: { id: srv.id, name: srv.name }, access: t.access, requiresApproval: t.requiresApproval, score: null })),
        ),
      );
    },
    'catalog.tags': () => {
      const counts = new Map<string, number>();
      for (const s of D.catalogServers()) for (const t of s.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
      return { tags: [...counts].map(([name, count]) => ({ name, count })) };
    },

    /* audit / metrics / sessions */
    'audit.events': (c: Ctx) => {
      const s = qs(c);
      const decisions = s.getAll('decision');
      const statuses = s.getAll('status');
      const kinds = s.getAll('kind');
      return page(
        D.AUDIT_EVENTS.filter(
          (e) =>
            (decisions.length === 0 || decisions.includes(e.decision)) &&
            (statuses.length === 0 || statuses.includes(e.status)) &&
            (kinds.length === 0 || kinds.includes(e.kind)) &&
            (!s.get('agentId') || e.agent?.id === s.get('agentId')) &&
            (!s.get('userId') || e.user?.id === s.get('userId')) &&
            (!s.get('serverId') || e.server?.id === s.get('serverId')) &&
            (!s.get('sessionId') || e.sessionId === s.get('sessionId')) &&
            includes(`${e.tool?.qualifiedName ?? ''} ${e.errorMessage ?? ''} ${e.adminAction ?? ''}`, s.get('q')),
        ),
      );
    },
    'audit.event': (c: Ctx) => D.auditEventFull(param(c, 'id')) ?? notFound(),
    'audit.verify': { jobId: 'job-verify' },
    'metrics.summary': () => D.metricsSummary(),
    'metrics.timeseries': (c: Ctx) => {
      const s = qs(c);
      return D.timeseries(s.get('from')!, s.get('to')!, s.get('interval') as '1h');
    },
    'metrics.breakdown': (c: Ctx) => D.breakdown(qs(c).get('dimension') ?? 'server'),
    'sessions.list': (c: Ctx) => {
      const s = qs(c);
      return page(D.SESSIONS.filter((x) => (s.get('active') === 'true' ? x.active : true) && (!s.get('agentId') || x.agent.id === s.get('agentId'))));
    },
    'sessions.get': (c: Ctx) => D.sessionDetail(param(c, 'id')) ?? notFound(),
    'sessions.events': (c: Ctx) => page(D.sessionEvents(param(c, 'id'))),

    /* settings */
    'settings.get': D.SETTINGS,
    'settings.update': async (c: Ctx) => ({ ...D.SETTINGS, ...(await body<object>(c)) }),
    'settings.oidc': D.OIDC_SETTINGS,
    'settings.updateOidc': async (c: Ctx) => ({ ...D.OIDC_SETTINGS, ...(await body<object>(c)) }),
    'settings.testExport': { ok: true, status: 200, error: null },
    'redaction.list': () => ({ items: D.REDACTION_RULES }),
    'redaction.create': async (c: Ctx) => ({ id: `rule-${Date.now()}`, replacement: '[REDACTED]', enabled: true, order: D.REDACTION_RULES.length + 1, builtin: false, ...(await body<object>(c)) }),
    'redaction.update': async (c: Ctx) => ({ ...(D.REDACTION_RULES.find((r) => r.id === param(c, 'id')) ?? notFound()), ...(await body<object>(c)) }),
    'redaction.delete': null,
    'redaction.test': async (c: Ctx) => {
      const b = await body<{ sample: Record<string, unknown> }>(c);
      const rules = D.REDACTION_RULES.filter((r) => r.enabled && r.type === 'key');
      const vals = D.REDACTION_RULES.filter((r) => r.enabled && r.type === 'regex');
      const matches: { path: string[]; ruleId: string }[] = [];
      const walk = (v: unknown, path: string[]): unknown => {
        if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
        return Object.fromEntries(
          Object.entries(v as Record<string, unknown>).map(([k, x]) => {
            const rule = rules.find((r) => new RegExp(r.pattern, 'i').test(k));
            if (rule) {
              matches.push({ path: [...path, k], ruleId: rule.id });
              return [k, { $redacted: rule.name }];
            }
            const vrule = typeof x === 'string' ? vals.find((r) => new RegExp(r.pattern).test(x)) : undefined;
            if (vrule) {
              matches.push({ path: [...path, k], ruleId: vrule.id });
              return [k, { $redacted: vrule.name }];
            }
            return [k, walk(x, [...path, k])];
          }),
        );
      };
      return { redacted: walk(b.sample, []), matches };
    },

    /* approvals */
    'approvals.list': (c: Ctx) => page(qs(c).get('status') === 'resolved' ? D.RESOLVED_APPROVALS : D.APPROVALS),
    'approvals.get': (c: Ctx) => [...D.APPROVALS, ...D.RESOLVED_APPROVALS].find((a) => a.id === param(c, 'id')) ?? notFound(),
    'approvals.approve': (c: Ctx) => ({ ...(D.APPROVALS.find((a) => a.id === param(c, 'id')) ?? D.APPROVALS[0]!), status: 'approved', decidedBy: { id: D.PEOPLE.dana.id, name: D.PEOPLE.dana.name }, decidedAt: new Date().toISOString(), actions: [] }),
    'approvals.deny': async (c: Ctx) => ({
      ...(D.APPROVALS.find((a) => a.id === param(c, 'id')) ?? D.APPROVALS[0]!),
      status: 'denied',
      reason: (await body<{ reason: string }>(c)).reason,
      decidedBy: { id: D.PEOPLE.dana.id, name: D.PEOPLE.dana.name },
      decidedAt: new Date().toISOString(),
      actions: [],
    }),

    /* OAuth: consent, authorized apps, upstream connections */
    'oauth.getConsent': () => D.consentRequest(false),
    'oauth.decideConsent': async (c: Ctx) => {
      const b = await body<{ decision: 'approve' | 'deny' }>(c);
      return { redirectTo: b.decision === 'approve' ? 'http://[::1]:33418/callback?code=demo&state=xyz&iss=https%3A%2F%2Fmcp.acme.example' : 'http://[::1]:33418/callback?error=access_denied&state=xyz' };
    },
    'oauth.revokeMyGrant': null,
    'oauth.clients': (c: Ctx) => {
      const s = qs(c);
      return page(D.OAUTH_CLIENTS.filter((x) => includes(`${x.name} ${x.clientId}`, s.get('q')) && (!s.get('status') || x.status === s.get('status'))));
    },
    'oauth.updateClient': async (c: Ctx) => {
      const row = D.OAUTH_CLIENTS.find((x) => x.id === param(c, 'id'));
      return row ? { ...row, ...(await body<{ status: 'active' | 'blocked' }>(c)) } : notFound();
    },
    'system.info': D.SYSTEM_INFO,
    'system.names': (c: Ctx) => {
      const ids = new Set(qs(c).getAll('ids'));
      const names: Record<string, { type: 'user' | 'group' | 'agent' | 'server' | 'tool'; name: string }> = {};
      for (const u of D.USERS) if (ids.has(u.id)) names[u.id] = { type: 'user', name: u.name };
      for (const g of D.GROUP_ROWS) if (ids.has(g.id)) names[g.id] = { type: 'group', name: g.name };
      for (const a of D.AGENTS) if (ids.has(a.id)) names[a.id] = { type: 'agent', name: a.name };
      for (const s of D.SERVERS) if (ids.has(s.id)) names[s.id] = { type: 'server', name: s.name };
      for (const t of D.TOOLS) if (ids.has(t.id)) names[t.id] = { type: 'tool', name: t.qualifiedName };
      return { names };
    },
    'system.reindex': { jobId: 'job-reindex' },
    'system.rotateKeys': { jobId: 'job-rotate' },
    'connections.list': () => ({ items: D.CONNECTIONS }),
    'connections.disconnect': null,
    'settings.testOidc': { ok: true, issuer: D.OIDC_SETTINGS.issuer, authorizationEndpoint: `${D.OIDC_SETTINGS.issuer}/v1/authorize`, error: null },
  };
}
