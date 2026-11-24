import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { meFixture } from '@/mocks/fixtures';
import { OAUTH_CLIENTS, SYSTEM_INFO } from '@/mocks/demo-data';
import { renderRoute } from '@/test/render';
import { redirectHosts } from './oauth-clients-tab';
import { indexCoverage } from './system-tab';

describe('settings: OAuth clients', () => {
  it('lists registered clients and blocks one after confirmation', async () => {
    let req: { id: string; body: unknown } | null = null;
    const { user } = await renderRoute('/admin/settings?tab=oauth-clients', {
      fixtures: {
        'oauth.updateClient': async ({ request, params }: { request: Request; params: Record<string, unknown> }) => {
          req = { id: String(params.id), body: await request.json() };
          return { ...OAUTH_CLIENTS[0]!, status: 'blocked' };
        },
      },
    });
    await screen.findAllByText('Claude Code');
    const table = screen.getByRole('table', { name: 'OAuth clients' });
    expect(within(table).getByText('Claude Code')).toBeInTheDocument();
    expect(within(table).getByText('[::1], claude.ai')).toBeInTheDocument();
    expect(within(table).getByText('Blocked')).toBeInTheDocument();
    await user.click(within(table).getByRole('button', { name: 'Block Claude Code' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/14 user\(s\) are affected/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Block client' }));
    await waitFor(() => expect(req).toEqual({ id: OAUTH_CLIENTS[0]!.id, body: { status: 'blocked' } }));
  });

  it('filters by status and offers unblock for a blocked client', async () => {
    const seen: string[] = [];
    const { user } = await renderRoute('/admin/settings?tab=oauth-clients', {
      fixtures: {
        'oauth.clients': ({ request }: { request: Request }) => {
          const status = new URL(request.url).searchParams.get('status');
          seen.push(status ?? 'all');
          const items = OAUTH_CLIENTS.filter((c) => !status || c.status === status);
          return { items, nextCursor: null, totalEstimate: items.length };
        },
      },
    });
    await screen.findByRole('table', { name: 'OAuth clients' });
    await user.click(within(screen.getByRole('radiogroup', { name: 'Client status' })).getByRole('radio', { name: 'Blocked' }));
    await waitFor(() => expect(seen).toContain('blocked'));
    const table = screen.getByRole('table', { name: 'OAuth clients' });
    await waitFor(() => expect(within(table).queryByText('Claude Code')).not.toBeInTheDocument());
    expect(within(table).getByRole('button', { name: 'Unblock MCP Inspector' })).toBeInTheDocument();
  });

  it('auditors see the list without block actions', async () => {
    await renderRoute('/admin/settings?tab=oauth-clients', { me: meFixture('auditor') });
    await screen.findAllByText('Claude Code');
    const table = screen.getByRole('table', { name: 'OAuth clients' });
    expect(within(table).getByText('Claude Code')).toBeInTheDocument();
    expect(within(table).queryByRole('button', { name: /block/i })).not.toBeInTheDocument();
  });

  it('redirectHosts dedupes hosts and tolerates non-URLs', () => {
    expect(redirectHosts(['http://localhost/a', 'http://localhost/b', 'myapp:/cb'])).toBe('localhost, myapp:/cb');
    expect(redirectHosts([])).toBe('—');
  });
});

describe('settings: System', () => {
  it('shows runtime and search index info', async () => {
    await renderRoute('/admin/settings?tab=system');
    expect(await screen.findByText(SYSTEM_INFO.mcpUrl)).toBeInTheDocument();
    expect(screen.getByText('PostgreSQL')).toBeInTheDocument();
    expect(screen.getByText('24 of 24 tools embedded')).toBeInTheDocument();
  });

  it('rebuilds the search index as a job and reports completion', async () => {
    let started = false;
    const { user } = await renderRoute('/admin/settings?tab=system', {
      fixtures: { 'system.reindex': () => ((started = true), { jobId: 'job-reindex' }) },
    });
    await user.click(await screen.findByRole('button', { name: 'Rebuild index…' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Rebuild index' }));
    await waitFor(() => expect(started).toBe(true));
    expect(await screen.findByText('Done')).toBeInTheDocument();
  });

  it('rotates the data key with the dek type', async () => {
    let body: unknown;
    const { user } = await renderRoute('/admin/settings?tab=system', {
      fixtures: { 'system.rotateKeys': async ({ request }: { request: Request }) => ((body = await request.json()), { jobId: 'job-rotate' }) },
    });
    await user.click(await screen.findByRole('button', { name: 'Rotate data key…' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Rotate data key' }));
    await waitFor(() => expect(body).toEqual({ type: 'dek' }));
  });

  it('auditors get no maintenance actions', async () => {
    await renderRoute('/admin/settings?tab=system', { me: meFixture('auditor') });
    await screen.findByText(SYSTEM_INFO.mcpUrl);
    expect(screen.queryByRole('button', { name: 'Rebuild index…' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rotate data key…' })).not.toBeInTheDocument();
  });

  it('indexCoverage formats hybrid and keyword modes', () => {
    expect(indexCoverage({ searchMode: 'hybrid', searchIndex: { tools: 3, embedded: 2 } })).toBe('2 of 3 tools embedded');
    expect(indexCoverage({ searchMode: 'keyword', searchIndex: { tools: 3, embedded: 0 } })).toBe('3 tools (keyword search only)');
    expect(indexCoverage({ searchMode: 'hybrid' })).toBe('—');
  });
});
