import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Connection } from '@neurouter/shared';
import { CONNECTIONS, SERVER_IDS } from '@/mocks/demo-data';
import { browserNavigation } from '@/lib/navigation';
import { renderRoute } from '@/test/render';
import { authorizeUrl, connectErrorMessage } from './connections';

describe('connections helpers', () => {
  it('builds the authorize navigation and maps return error codes', () => {
    expect(authorizeUrl('abc')).toBe('/api/me/connections/abc/authorize?returnTo=%2Fconnections');
    expect(authorizeUrl('abc', '/catalog')).toBe('/api/me/connections/abc/authorize?returnTo=%2Fcatalog');
    expect(connectErrorMessage('access_denied')).toMatch(/declined/);
    expect(connectErrorMessage('weird')).toBe('The connection failed (weird).');
  });
});

describe('/connections (W10 acceptance)', () => {
  it('lists status per server and starts connect / reconnect as full-page navigations', async () => {
    const assign = vi.spyOn(browserNavigation, 'assign').mockImplementation(() => {});
    const expired: Connection = { ...CONNECTIONS[1]!, server: { id: SERVER_IDS.slack, name: 'slack' }, status: 'expired' };
    const { user } = await renderRoute('/connections', { fixtures: { 'connections.list': { items: [...CONNECTIONS, expired] } } });
    const list = await screen.findByRole('list', { name: 'Connections' });
    expect(within(list).getByText('Not connected')).toBeInTheDocument();
    expect(within(list).getByText('Connected as dana.whitfield@acme.example')).toBeInTheDocument();
    expect(within(list).getByText('Expired')).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: 'Connect github' }));
    expect(assign).toHaveBeenCalledWith(`/api/me/connections/${SERVER_IDS.github}/authorize?returnTo=%2Fconnections`);
    await user.click(within(list).getByRole('button', { name: 'Reconnect slack' }));
    expect(assign).toHaveBeenLastCalledWith(`/api/me/connections/${SERVER_IDS.slack}/authorize?returnTo=%2Fconnections`);
  });

  it('reflects status after the OAuth round trip: toasts ?connected and strips the params', async () => {
    const connected = CONNECTIONS.map((c) => (c.server.id === SERVER_IDS.github ? { ...c, status: 'connected' as const, accountLabel: 'dana-w', connectedAt: new Date().toISOString() } : c));
    const { router } = await renderRoute(`/connections?connected=${SERVER_IDS.github}`, { fixtures: { 'connections.list': { items: connected } } });
    expect(await screen.findByText('Connected to github')).toBeInTheDocument();
    expect(screen.getByText('Connected as dana-w')).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.search).toEqual({}));
  });

  it('shows a readable error for ?error=&server=', async () => {
    const { router } = await renderRoute(`/connections?error=access_denied&server=${SERVER_IDS.github}`);
    expect(await screen.findByText("Couldn't connect to github")).toBeInTheDocument();
    expect(screen.getByText('You declined access on the upstream service.')).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.search).toEqual({}));
  });

  it('disconnect asks for confirmation and calls DELETE', async () => {
    const del = vi.fn(() => null);
    const { user } = await renderRoute('/connections', { fixtures: { 'connections.disconnect': del } });
    await user.click(await screen.findByRole('button', { name: 'Disconnect jira' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText('Disconnected from jira')).toBeInTheDocument();
    expect(del).toHaveBeenCalledTimes(1);
  });

  it('empty state', async () => {
    await renderRoute('/connections', { fixtures: { 'connections.list': { items: [] } } });
    expect(await screen.findByText('None of the servers you can access need a personal account.')).toBeInTheDocument();
  });
});
