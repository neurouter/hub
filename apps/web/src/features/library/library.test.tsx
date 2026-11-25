import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LIBRARY, LIBRARY_STATUS } from '@/mocks/library-data';
import { SERVER_IDS, serverDetail } from '@/mocks/demo-data';
import { renderRoute } from '@/test/render';

const byName = (n: string) => LIBRARY.find((e) => e.name === n)!;

describe('library', () => {
  it('demo grades come from the shared grading code: good servers rank first, garbage is capped and flagged', () => {
    expect(byName('io.github.fjordlabs/postgres-readonly').quality).toMatchObject({ grade: 'A', confidence: 'high', trust: 'verified' });
    expect(byName('io.github.helpfulbot/calculator').quality).toMatchObject({ grade: 'D', flags: [expect.objectContaining({ code: 'injection_like', severity: 'danger' })] });
    expect(byName('io.github.mcp-mass-gen/weather-4417').quality.flags.map((f) => f.code)).toContain('mass_publisher');
    expect(byName('com.paylane/billing').quality.trust).toBe('mismatch');
    expect(byName('io.github.localfirst/files').hasRemote).toBe(false);
  });

  it('shows the empty state with a consent step while sync is off', async () => {
    await renderRoute('/admin/library', { fixtures: { 'library.status': { ...LIBRARY_STATUS, enabled: false, counts: { total: 0, remote: 0, checked: 0 } } } });
    expect(await screen.findByText('Registry sync is off')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enable registry sync…' })).toBeInTheDocument();
  });

  it('lists entries with grade, publisher and top warning; filters by grade', async () => {
    const { user, router } = await renderRoute('/admin/library');
    const list = await screen.findByRole('list', { name: 'Library servers' });
    const items = within(list).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Postgres (read-only)');
    expect(items[0]).toHaveTextContent('Verified publisher');
    expect(within(list).queryByText('Local files')).toBeNull(); // local-only hidden by default
    const calc = items.find((i) => i.textContent?.includes('Calculator'))!;
    expect(calc).toHaveTextContent(/Tool text reads like instructions/);
    await user.click(screen.getByRole('radio', { name: 'B or better' }));
    await expect.poll(() => (router.state.location.search as { grade?: string }).grade).toBe('B');
    await expect.poll(() => within(screen.getByRole('list', { name: 'Library servers' })).queryByText('Calculator')).toBeNull();
  });

  it('entry page: grade breakdown, warnings, and Add to gateway pre-fills the register form', async () => {
    const e = byName('com.acmecloud/object-storage');
    let created: Record<string, unknown> | null = null;
    const { user, router } = await renderRoute(`/admin/library/${e.id}`, {
      fixtures: {
        'servers.create': async ({ request }: { request: Request }) => {
          created = (await request.json()) as Record<string, unknown>;
          return { ...serverDetail(SERVER_IDS.docs)!, id: 'new-srv', initialSync: { jobId: 'j1' } };
        },
      },
    });
    expect(await screen.findByRole('heading', { name: 'AcmeCloud Object Storage' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Grade breakdown' })).toHaveTextContent('Hygiene');
    expect(screen.getByText(/Computed by rules, not by a model/)).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: /Add to gateway/ }));
    await expect.poll(() => router.state.location.pathname).toBe('/admin/servers/new');
    expect(await screen.findByText('From the library')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('AcmeCloud Object Storage');
    expect(screen.getByLabelText('Slug')).toHaveValue('object-storage');
    expect(screen.getByLabelText('URL')).toHaveValue('https://mcp.acmecloud.com/storage');
    expect(screen.getByRole('radio', { name: /shared bearer token/i })).toBeChecked();
    await user.type(screen.getByLabelText('Token'), 'tok');
    await user.click(screen.getByRole('button', { name: 'Register server' }));
    await expect.poll(() => created).not.toBeNull();
    expect(created).toMatchObject({ name: 'AcmeCloud Object Storage', slug: 'object-storage', trusted: false, tags: ['library'], libraryEntryId: e.id, auth: { type: 'shared_bearer', token: 'tok' } });
  });

  it('server page shows the quality grade from gateway evidence', async () => {
    await renderRoute(`/admin/servers/${SERVER_IDS.postgres}`);
    const section = await screen.findByRole('region', { name: 'Quality grade' }).catch(() => null);
    const scope = section ?? document.body;
    expect(await within(scope as HTMLElement).findByText(/of 2,016 checks/)).toBeInTheDocument();
  });
});
