import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVER_IDS } from '@/mocks/demo-data';
import { meFixture } from '@/mocks/fixtures';
import { browserNavigation } from '@/lib/navigation';
import { renderRoute } from '@/test/render';
import { activeFilterCount } from '@/routes/_app/catalog/index';

describe('catalog tool search (W8)', () => {
  it('no-results state offers the servers view and clearing the search', async () => {
    const { user, router } = await renderRoute('/catalog?view=tools&q=zzzz', { fixtures: { 'catalog.tools': { items: [], nextCursor: null } } });
    expect(await screen.findByText('No tools match “zzzz”')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Search servers instead' }));
    await waitFor(() => expect(router.state.location.search).toEqual({ q: 'zzzz' }));
  });

  it('"Did you mean" offers the server’s corrected query and searches it on click', async () => {
    const { user, router } = await renderRoute('/catalog?view=tools&q=crate%20isue', {
      fixtures: { 'catalog.tools': ({ request }: { request: Request }) => (new URL(request.url).searchParams.get('q') === 'crate isue' ? { items: [], nextCursor: null, suggestion: 'create issue' } : { items: [], nextCursor: null, suggestion: null }) },
    });
    expect(await screen.findByText(/Did you mean/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'create issue' }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ view: 'tools', q: 'create issue' }));
    expect(await screen.findByText('No tools match “create issue”')).toBeInTheDocument();
    expect(screen.queryByText(/Did you mean/)).not.toBeInTheDocument();
  });

  it('keeps the server’s relevance order and notes truncation', async () => {
    const mk = (id: string, qn: string) => ({ id, qualifiedName: qn, title: null, description: 'd', server: { id: SERVER_IDS.github, name: 'github' }, access: 'allowed' as const, requiresApproval: false, score: 0.5 });
    await renderRoute('/catalog?view=tools&q=pr', { fixtures: { 'catalog.tools': { items: [mk('b', 'github__merge_pull_request'), mk('a', 'github__get_pull_request')], nextCursor: 'c2' } } });
    const list = await screen.findByRole('list', { name: 'Tools' });
    expect(within(list).getAllByRole('link').map((l) => l.textContent)).toEqual(['github__merge_pull_request', 'github__get_pull_request']);
    expect(screen.getByText('Best matches first')).toBeInTheDocument();
    expect(screen.getByText(/Showing the first 2 results/)).toBeInTheDocument();
  });

  it('counts active filters', () => {
    expect(activeFilterCount({})).toBe(0);
    expect(activeFilterCount({ tag: ['a', 'b'], access: 'granted' })).toBe(3);
    expect(activeFilterCount({ access: 'all' })).toBe(0);
  });
});

describe('catalog at 375 px (MobileCatalog)', () => {
  const width = window.innerWidth;
  beforeEach(() => {
    window.innerWidth = 375;
  });
  afterEach(() => {
    window.innerWidth = width;
  });

  it('moves filters into a "Filters (n)" sheet and applies them to the URL', async () => {
    const { user, router } = await renderRoute('/catalog?access=granted', { me: meFixture('user') });
    const btn = await screen.findByRole('button', { name: 'Filters (1)' });
    expect(screen.getByText(/Access: Available to me/)).toBeInTheDocument();
    // desktop controls are not rendered
    expect(screen.queryByRole('combobox', { name: 'Access' })).not.toBeInTheDocument();
    await user.click(btn);
    const sheet = await screen.findByRole('dialog', { name: 'Filters' });
    await user.click(within(sheet).getByRole('radio', { name: 'Requestable' }));
    await user.click(within(sheet).getByRole('checkbox', { name: /planning/ }));
    await user.click(within(sheet).getByRole('button', { name: 'Show results' }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ access: 'requestable', tag: ['planning'] }));
    expect(await screen.findByRole('button', { name: 'Filters (2)' })).toBeInTheDocument();
  });

  it('renders compact cards with Connect account and Tools actions', async () => {
    const assign = vi.spyOn(browserNavigation, 'assign').mockImplementation(() => {});
    const { user } = await renderRoute('/catalog', { me: meFixture('user') });
    const card = (await screen.findByRole('link', { name: 'github' })).closest('article') as HTMLElement;
    expect(card.textContent).toMatch(/\d+ tools · engineering, source-control/);
    await user.click(within(card).getByRole('button', { name: 'Connect account' }));
    expect(assign).toHaveBeenCalledWith(`/api/me/connections/${SERVER_IDS.github}/authorize?returnTo=%2Fcatalog`);
    expect(within(card).getByRole('link', { name: 'Tools' })).toHaveAttribute('href', `/catalog/${SERVER_IDS.github}`);
  });
});
