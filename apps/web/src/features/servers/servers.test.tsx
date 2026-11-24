import { screen, waitFor, within } from '@testing-library/react';
import { HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { meFixture } from '@/mocks/fixtures';
import { SERVER_IDS, serverDetail } from '@/mocks/demo-data';
import { renderRoute } from '@/test/render';
import { defaultAuth, serverFormSchema, toCreateBody } from './server-form';
import { credentialsBody } from './credentials-panel';
import { runSync } from './use-sync';
import { server } from '@/test/msw-server';
import { createContractHandlers } from '@/mocks/handlers';

describe('register server form', () => {
  it('auth schema requires fields per type and switching type drops the old fields', () => {
    const base = { name: 'Docs', slug: 'docs', tags: '', owner: { id: 'u1', name: 'Dana' }, url: 'https://x.example/mcp', transport: 'streamable_http' as const, trusted: false };
    const bad = serverFormSchema.safeParse({ ...base, auth: defaultAuth('shared_header') });
    expect(bad.success).toBe(false);
    expect(bad.error!.issues.map((i) => i.path.join('.'))).toEqual(expect.arrayContaining(['auth.headerName', 'auth.headerValue']));
    expect(defaultAuth('none')).toEqual({ type: 'none' });
    expect(defaultAuth('shared_bearer')).toEqual({ type: 'shared_bearer', token: '' });
    const ok = serverFormSchema.parse({ ...base, tags: 'a, b ,', auth: { type: 'shared_bearer', token: 's3cret' } });
    expect(toCreateBody(ok)).toEqual({ name: 'Docs', slug: 'docs', tags: ['a', 'b'], ownerId: 'u1', url: 'https://x.example/mcp', transport: 'streamable_http', trusted: false, auth: { type: 'shared_bearer', token: 's3cret' } });
  });

  it('derives the slug, tests the connection and registers', async () => {
    let created: Record<string, unknown> | null = null;
    const { user, router } = await renderRoute('/admin/servers/new', {
      fixtures: {
        'servers.create': async ({ request }: { request: Request }) => {
          created = (await request.json()) as Record<string, unknown>;
          return { ...serverDetail(SERVER_IDS.docs)!, id: 'new-srv', initialSync: { jobId: 'j1' } };
        },
      },
    });
    await user.type(await screen.findByLabelText('Name'), 'Internal Docs');
    expect(screen.getByLabelText('Slug')).toHaveValue('internal-docs');
    expect(screen.getByText('internal-docs__tool_name')).toBeInTheDocument();
    await user.type(screen.getByLabelText('URL'), 'https://docs-mcp.acme.example/mcp');
    await user.click(screen.getByRole('radio', { name: /shared bearer token/i }));
    const token = screen.getByLabelText('Token');
    await user.type(token, 'abc');
    // switching type removes the token field and its value
    await user.click(screen.getByRole('radio', { name: /shared header/i }));
    expect(screen.queryByLabelText('Token')).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /shared bearer token/i }));
    expect(screen.getByLabelText('Token')).toHaveValue('');
    await user.type(screen.getByLabelText('Token'), 's3cret');

    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/Connected in 184 ms/)).toBeInTheDocument();
    expect(screen.getByText(/7 tools found/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Register server' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/servers/new-srv'));
    expect((router.state.location.search as { tab?: string }).tab).toBe('tools');
    expect(created).toMatchObject({ name: 'Internal Docs', slug: 'internal-docs', auth: { type: 'shared_bearer', token: 's3cret' }, ownerId: meFixture('admin').user.id });
  });

  it('after registering, follows the initial sync job and shows the discovered tools without a reload', async () => {
    const { TOOLS } = await import('@/mocks/demo-data');
    const tool = { ...TOOLS[0]!, qualifiedName: 'new-docs__lookup', server: { ...TOOLS[0]!.server, id: 'new-srv' } };
    let polls = 0;
    let synced = false;
    const { user } = await renderRoute('/admin/servers/new', {
      fixtures: {
        'servers.create': () => ({ ...serverDetail(SERVER_IDS.docs)!, id: 'new-srv', initialSync: { jobId: 'job-initial' } }),
        'servers.get': () => ({ ...serverDetail(SERVER_IDS.docs)!, id: 'new-srv' }),
        // the job is still running on the first poll, then succeeds
        'jobs.get': () => {
          polls += 1;
          const done = polls >= 2;
          synced = done;
          return { id: 'job-initial', kind: 'tool_sync', status: done ? 'succeeded' : 'running', progress: done ? 1 : 0, result: done ? { added: 1, changed: 0, removed: 0, unchanged: 0 } : null, error: null, createdAt: new Date().toISOString(), finishedAt: done ? new Date().toISOString() : null };
        },
        'tools.list': () => ({ items: synced ? [tool] : [], nextCursor: null }),
      },
    });
    await user.type(await screen.findByLabelText('Name'), 'New Docs');
    await user.type(screen.getByLabelText('URL'), 'https://docs-mcp.acme.example/mcp');
    await user.click(screen.getByRole('button', { name: 'Register server' }));
    expect(await screen.findByText('No tools yet')).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'new-docs__lookup' }, { timeout: 4000 })).toBeInTheDocument();
  });

  it('shows required-field errors per auth type on submit', async () => {
    const { user } = await renderRoute('/admin/servers/new');
    await user.click(await screen.findByRole('radio', { name: /shared header/i }));
    await user.click(screen.getByRole('button', { name: 'Register server' }));
    expect(await screen.findAllByText(/too small|required|invalid/i)).not.toHaveLength(0);
    expect(screen.getByLabelText('Header name')).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('servers pages', () => {
  it('owners see "My servers" and no Register button', async () => {
    let calls = 0;
    await renderRoute('/admin/servers', { me: meFixture('owner'), fixtures: { 'servers.list': () => ((calls += 1), { items: [], nextCursor: null }) } });
    expect(await screen.findByRole('heading', { level: 1, name: 'My servers' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /register server/i })).not.toBeInTheDocument();
    await waitFor(() => expect(calls).toBe(1));
  });

  it('admins see health, pending review counts and Register', async () => {
    await renderRoute('/admin/servers');
    const table = await screen.findByRole('table', { name: 'Servers' });
    expect(await within(table).findByText('Healthy · 182 ms')).toBeInTheDocument();
    expect(within(table).getByText('1 pending')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /register server/i })).toBeInTheDocument();
  });

  it('secrets are write-only: replace clears the input and never renders the value', async () => {
    let body: unknown;
    const { user } = await renderRoute(`/admin/servers/${SERVER_IDS.docs}?tab=auth`, {
      fixtures: { 'servers.putCredentials': async ({ request }: { request: Request }) => ((body = await request.json()), { hasSecret: true, secretUpdatedAt: '2026-11-24T10:00:00.000Z' }) },
    });
    expect(await screen.findByText('set')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /replace token/i }));
    await user.type(screen.getByLabelText('New token'), 'super-secret-value');
    await user.click(screen.getByRole('button', { name: 'Save secret' }));
    await waitFor(() => expect(body).toEqual({ token: 'super-secret-value' }));
    await waitFor(() => expect(screen.queryByLabelText('New token')).not.toBeInTheDocument());
    expect(document.body.textContent).not.toContain('super-secret-value');
    expect(credentialsBody('shared_header', 'v')).toEqual({ headerValue: 'v' });
    expect(credentialsBody('none', 'v')).toBeNull();
  });

  it('settings: owners set an icon override (validated https/data URL) and refresh the icon', async () => {
    let patched: unknown;
    let refreshed = false;
    const { user } = await renderRoute(`/admin/servers/${SERVER_IDS.docs}?tab=settings`, {
      fixtures: {
        'servers.update': async ({ request }: { request: Request }) => ((patched = await request.json()), serverDetail(SERVER_IDS.docs)),
        'servers.refreshIcon': () => ((refreshed = true), { ok: true, error: null }),
      },
    });
    const input = await screen.findByLabelText('Icon URL');
    await user.type(input, 'http://insecure.test/a.png');
    expect(screen.getByText('Use an https:// or data:image/ URL.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set icon' })).toBeDisabled();
    await user.clear(input);
    await user.type(input, 'https://cdn.test/icon.png');
    await user.click(screen.getByRole('button', { name: 'Set icon' }));
    await waitFor(() => expect(patched).toEqual({ iconUrl: 'https://cdn.test/icon.png' }));
    await user.click(screen.getByRole('button', { name: 'Refresh icon' }));
    await waitFor(() => expect(refreshed).toBe(true));
  });

  it('server lists and headers render the proxied icon', async () => {
    await renderRoute('/admin/servers');
    const table = await screen.findByRole('table', { name: 'Servers' });
    await waitFor(() => expect(table.querySelectorAll('[data-slot=server-icon]').length).toBeGreaterThan(0));
  });

  it('auditors see credential status but cannot replace it', async () => {
    await renderRoute(`/admin/servers/${SERVER_IDS.docs}?tab=auth`, { me: meFixture('auditor') });
    expect(await screen.findByText('set')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /replace/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sync now/i })).not.toBeInTheDocument();
  });

  it('sync polls the job until it is terminal', async () => {
    let polls = 0;
    server.use(
      ...createContractHandlers({
        'servers.sync': { jobId: 'job-1' },
        'jobs.get': () => {
          polls += 1;
          return HttpResponse.json({ id: 'job-1', kind: 'tool_sync', status: polls < 3 ? 'running' : 'succeeded', progress: null, result: polls < 3 ? null : { added: 2, changed: 1, removed: 0, unchanged: 3 }, error: null, createdAt: '2026-11-24T10:00:00.000Z', finishedAt: null });
        },
      }),
    );
    const job = await runSync('s1', 1);
    expect(job.status).toBe('succeeded');
    expect(polls).toBe(3);
  });
});

describe('server sync history', () => {
  it('lists sync runs with trigger, result and change counts on the overview', async () => {
    const t0 = '2026-11-20T10:00:00.000Z';
    const runs = [
      { id: 'r2', trigger: 'notification', status: 'ok', startedAt: t0, finishedAt: '2026-11-20T10:00:01.500Z', added: 2, changed: 1, removed: 0, unchanged: 20, error: null },
      { id: 'r1', trigger: 'schedule', status: 'error', startedAt: t0, finishedAt: t0, added: 0, changed: 0, removed: 0, unchanged: 0, error: 'upstream 503' },
    ];
    await renderRoute(`/admin/servers/${SERVER_IDS.docs}`, { fixtures: { 'servers.syncRuns': { items: runs, nextCursor: null } } });
    await screen.findAllByText('upstream 503');
    const table = screen.getByRole('table', { name: 'Sync history' });
    expect(within(table).getByText('Server notified')).toBeInTheDocument();
    expect(within(table).getByText('2 new · 1 changed · 0 removed')).toBeInTheDocument();
    expect(within(table).getByText('Failed')).toBeInTheDocument();
  });

  it('syncCounts hides counts while running', async () => {
    const { syncCounts } = await import('./sync-history');
    expect(syncCounts({ status: 'running', added: 0, changed: 0, removed: 0 })).toBe('—');
    expect(syncCounts({ status: 'ok', added: 1, changed: 0, removed: 3 })).toBe('1 new · 0 changed · 3 removed');
  });
});
