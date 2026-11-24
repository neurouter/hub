import { screen, waitFor, within } from '@testing-library/react';
import { HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import type { AccessRequest, CatalogServer } from '@neurouter/shared';
import { meFixture } from '@/mocks/fixtures';
import { ACCESS_REQUESTS, GRANTS, PEOPLE, SERVER_IDS, catalogServerDetail, catalogServers } from '@/mocks/demo-data';
import { browserNavigation } from '@/lib/navigation';
import { renderRoute } from '@/test/render';
import { reasonError } from '@/features/access-requests/request-access-dialog';
import { approveBody } from '@/features/access-requests/review-dialogs';

const page = <T,>(items: T[]) => ({ items, nextCursor: null });

describe('portal flow (W7 acceptance)', () => {
  it('request → appears in the admin queue → approve → catalog shows granted', async () => {
    // shared backend state across the three renders
    const state = { servers: catalogServers().map((s) => ({ ...s, access: s.id === SERVER_IDS.postgres ? ('none' as const) : s.access })) as CatalogServer[], requests: [] as AccessRequest[] };
    const fixtures = {
      'catalog.servers': () => page(state.servers),
      'accessRequests.listMine': () => page(state.requests),
      'accessRequests.list': () => page(state.requests.filter((r) => r.status === 'pending')),
      'accessRequests.create': async ({ request }: { request: Request }) => {
        const b = (await request.json()) as { reason: string };
        const r: AccessRequest = { ...ACCESS_REQUESTS[0]!, id: 'ar-new', agent: null, reason: b.reason, requester: { id: PEOPLE.sam.id, name: PEOPLE.sam.name } };
        state.requests.push(r);
        state.servers = state.servers.map((s) => (s.id === SERVER_IDS.postgres ? { ...s, access: 'pending' } : s));
        return HttpResponse.json(r, { status: 201 });
      },
      'accessRequests.approve': () => {
        state.requests = state.requests.map((r) => ({ ...r, status: 'approved' as const }));
        state.servers = state.servers.map((s) => (s.id === SERVER_IDS.postgres ? { ...s, access: 'granted' } : s));
        return { request: state.requests[0]!, grant: GRANTS[0]! };
      },
    };

    // 1. a user with no access requests it from the catalog
    const u = await renderRoute('/catalog', { me: meFixture('user'), fixtures });
    await u.user.click(await screen.findByRole('button', { name: 'Request access to postgres-analytics' }));
    const dialog = await screen.findByRole('dialog');
    await u.user.click(within(dialog).getByRole('button', { name: 'Send request' }));
    expect(await within(dialog).findByText(/at least 10 characters/)).toBeInTheDocument();
    await u.user.type(within(dialog).getByLabelText(/reason/i), 'Weekly revenue questions from sales.');
    await u.user.click(within(dialog).getByRole('button', { name: 'Send request' }));
    const card = (await screen.findByRole('link', { name: 'postgres-analytics' })).closest('article')!;
    await waitFor(() => expect(within(card as HTMLElement).getAllByText('Requested').length).toBeGreaterThan(0));
    u.unmount();

    // 2. the admin sees it in the queue and approves
    const a = await renderRoute('/admin/access-requests', { fixtures });
    const table = await screen.findByRole('table', { name: 'Pending access requests' });
    await a.user.click(await within(table).findByRole('button', { name: `Approve request from ${PEOPLE.sam.name}` }));
    await a.user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(within(table).queryByText(PEOPLE.sam.name)).not.toBeInTheDocument());
    a.unmount();

    // 3. the catalog now shows access granted
    await renderRoute('/catalog', { me: meFixture('user'), fixtures });
    const granted = (await screen.findByRole('link', { name: 'postgres-analytics' })).closest('article') as HTMLElement;
    expect(within(granted).getByText('Access granted')).toBeInTheDocument();
  });
});

describe('catalog', () => {
  it('a user with no grants sees a requestable catalog', async () => {
    await renderRoute('/catalog', { me: meFixture('user'), fixtures: { 'catalog.servers': page(catalogServers().map((s) => ({ ...s, access: 'none' }))), 'accessRequests.listMine': page([]) } });
    expect((await screen.findAllByRole('button', { name: /^Request access to/ })).length).toBe(6);
  });

  it('search writes ?q and the tools view lists qualified names', async () => {
    const { user, router } = await renderRoute('/catalog');
    await user.type(await screen.findByRole('searchbox', { name: 'Search servers and tools' }), 'merge');
    await waitFor(() => expect((router.state.location.search as { q?: string }).q).toBe('merge'));
    await user.click(screen.getByRole('radio', { name: 'Tools' }));
    const list = await screen.findByRole('list', { name: 'Tools' });
    expect(await within(list).findByText('github__merge_pull_request')).toBeInTheDocument();
  });

  it('the result count matches the view and uses singular nouns for one', async () => {
    const one = { ...catalogServers()[0]!, toolCount: 1, tags: [] };
    const tools = [0, 1, 2, 3].map((i) => ({ id: crypto.randomUUID(), qualifiedName: `x__t${i}`, title: null, description: 'd', server: { id: one.id, name: one.name }, access: 'none', requiresApproval: false, score: null }));
    const { user } = await renderRoute('/catalog', {
      me: meFixture('user'),
      fixtures: { 'catalog.servers': () => page([one]), 'catalog.tools': () => page(tools) },
    });
    expect(await screen.findByText('1 server · 1 tool')).toBeInTheDocument();
    const card = (await screen.findByRole('link', { name: one.name })).closest('article') as HTMLElement;
    expect(within(card).getByText('tool')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Tools' }));
    expect(await screen.findByText('4 tools')).toBeInTheDocument();
  });

  it('server detail owner line has no trailing separator when the server has no tags', async () => {
    const srv = catalogServers().find((x) => x.id === SERVER_IDS.postgres)!;
    await renderRoute(`/catalog/${srv.id}`, { me: meFixture('user'), fixtures: { 'catalog.server': { ...catalogServerDetail(srv.id)!, tags: [] } } });
    const owner = await screen.findByText(/^Owner:/);
    expect(owner.textContent?.trim()).toMatch(/^Owner: [^·]+$/);
  });

  it('server detail shows my access, schema toggle and starts the account connection', async () => {
    const assign = vi.spyOn(browserNavigation, 'assign').mockImplementation(() => {});
    const { user } = await renderRoute(`/catalog/${SERVER_IDS.github}`);
    expect(await screen.findByText(/Connect your github account/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Toggle schema for create_issue' }));
    expect(screen.getByLabelText('Input schema of create_issue')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Tools' })).getAllByText('Denied').length).toBe(1);
    await user.click(screen.getByRole('button', { name: 'Connect account' }));
    expect(assign).toHaveBeenCalledWith(`/api/me/connections/${SERVER_IDS.github}/authorize?returnTo=${encodeURIComponent(`/catalog/${SERVER_IDS.github}`)}`);
  });

  it('unknown servers say "not found or not visible"', async () => {
    await renderRoute('/catalog/nope');
    expect(await screen.findByText('Server not found or not visible to you')).toBeInTheDocument();
  });

  it('validates the request reason length', () => {
    expect(reasonError('short')).toMatch(/at least 10/);
    expect(reasonError('a'.repeat(501))).toMatch(/under 500/);
    expect(reasonError('A reasonable reason')).toBeNull();
  });
});

describe('access request queue', () => {
  it('a 409 rolls back and says it was already handled', async () => {
    const { user } = await renderRoute('/admin/access-requests', {
      fixtures: { 'accessRequests.deny': () => HttpResponse.json({ type: 'x', title: 'Conflict', status: 409, code: 'conflict', requestId: 'r' }, { status: 409, headers: { 'content-type': 'application/problem+json' } }) },
    });
    const table = await screen.findByRole('table', { name: 'Pending access requests' });
    await user.click(await within(table).findByRole('button', { name: `Deny request from ${PEOPLE.lena.name}` }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Deny request' }));
    expect(await within(dialog).findByText('A note is required when denying.')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Note'), 'No.');
    await user.click(within(dialog).getByRole('button', { name: 'Deny request' }));
    expect(await screen.findByText('Already handled')).toBeInTheDocument();
    expect(await within(table).findByText(PEOPLE.lena.name)).toBeInTheDocument();
  });

  it('the Resolved tab asks the server for decided requests (status=resolved) and lists them', async () => {
    const statuses: (string | null)[] = [];
    const decided = { ...ACCESS_REQUESTS[0]!, status: 'approved' as const };
    await renderRoute('/admin/access-requests?tab=resolved', {
      fixtures: {
        'accessRequests.list': ({ request }: { request: Request }) => {
          const status = new URL(request.url).searchParams.get('status');
          statuses.push(status);
          return page(status === 'resolved' ? [decided] : []);
        },
      },
    });
    const table = await screen.findByRole('table', { name: 'Resolved access requests' });
    expect(await within(table).findByText(decided.requester.name)).toBeInTheDocument();
    expect(statuses).toContain('resolved');
  });

  it('approve body: grant to the agent, narrow a server request to a tool, expiry and note', () => {
    const r = ACCESS_REQUESTS[0]!;
    expect(approveBody(r, { grantTo: 'agent', group: null, tool: { id: 't1', name: 'x' }, expiresOn: '2027-01-31', note: ' ok ' })).toEqual({
      grantSubject: { type: 'agent', id: r.agent!.id },
      target: { type: 'tool', id: 't1' },
      expiresAt: '2027-01-31T23:59:59.000Z',
      note: 'ok',
    });
    expect(approveBody(r, { grantTo: 'user', group: null, tool: null, expiresOn: '', note: '' })).toEqual({ grantSubject: { type: 'user', id: r.requester.id } });
  });

  it('plain users get ForbiddenState', async () => {
    await renderRoute('/admin/access-requests', { me: meFixture('user') });
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
  });
});

describe('my requests, connect, activity', () => {
  it('cancels a pending request', async () => {
    let cancelled = '';
    const { user } = await renderRoute('/requests', { me: meFixture('user'), fixtures: { 'accessRequests.cancelMine': ({ params }: { params: Record<string, unknown> }) => ((cancelled = String(params.id)), new HttpResponse(null, { status: 204 })) } });
    const table = await screen.findByRole('table', { name: 'My access requests' });
    await user.click(await within(table).findByRole('button', { name: 'Cancel request for postgres-analytics' }));
    await waitFor(() => expect(cancelled).toBe(ACCESS_REQUESTS[0]!.id));
  });

  it('connect: snippet per client; a pasted key fills the snippet but never the URL', async () => {
    const { user, router } = await renderRoute('/connect');
    const snippet = await screen.findByTestId('code-snippet');
    expect(snippet).toHaveTextContent('claude mcp add --transport http neurouter https://mcp.acme.example/mcp');
    await user.click(screen.getByRole('radio', { name: /API key/ }));
    expect(snippet).toHaveTextContent('${NEUROUTER_API_KEY}');
    await user.type(screen.getByLabelText('Paste API key (optional)'), 'nr_live_pasted');
    expect(snippet).toHaveTextContent('Bearer nr_live_pasted');
    await user.click(screen.getByRole('tab', { name: 'Cursor' }));
    expect(screen.getByText('~/.cursor/mcp.json')).toBeInTheDocument();
    expect(router.state.location.href).not.toContain('nr_live_pasted');
  });

  it('my activity queries metrics and audit with scope=me', async () => {
    const scopes = new Set<string | null>();
    const rec = (fn: (p: URLSearchParams) => unknown) => ({ request }: { request: Request }) => {
      const p = new URL(request.url).searchParams;
      scopes.add(`${new URL(request.url).pathname}:${p.get('scope')}`);
      return fn(p);
    };
    const D = await import('@/mocks/demo-data');
    await renderRoute('/activity', {
      me: meFixture('user'),
      fixtures: {
        'metrics.summary': rec(() => D.metricsSummary()),
        'metrics.timeseries': rec((p) => D.timeseries(p.get('from')!, p.get('to')!, '15m')),
        'audit.events': rec(() => page(D.AUDIT_EVENTS.slice(0, 3))),
      },
    });
    expect(await screen.findByRole('table', { name: 'Audit events' })).toBeInTheDocument();
    await waitFor(() => expect([...scopes].sort()).toEqual(['/api/audit/events:me', '/api/metrics/summary:me', '/api/metrics/timeseries:me']));
  });
});
