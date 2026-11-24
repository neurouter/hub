import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CatalogTool } from '@neurouter/shared';
import { buildNav } from '@/app/nav';
import { meFixture } from '@/mocks/fixtures';
import { SERVER_IDS } from '@/mocks/demo-data';
import { renderRoute } from '@/test/render';
import { isPaletteShortcut, matchPages, moveActive, toolItems } from './palette';

const tool = (id: string, qn: string, serverId: string = SERVER_IDS.github): CatalogTool => ({
  id,
  qualifiedName: qn,
  title: null,
  description: `${qn} description`,
  server: { id: serverId, name: 'github' },
  access: 'allowed',
  requiresApproval: false,
  score: 0.9,
});

describe('palette helpers', () => {
  it('matches pages the role can open, every word must appear', () => {
    const user = buildNav(meFixture('user'));
    expect(matchPages(user, 'cat').map((p) => p.label)).toEqual(['Catalog']);
    expect(matchPages(user, 'users')).toEqual([]); // no admin pages for a plain user
    const admin = buildNav(meFixture('admin'));
    expect(matchPages(admin, 'admin users').map((p) => p.label)).toEqual(['Users']);
    expect(matchPages(admin, '', 3)).toHaveLength(3);
  });

  it('keeps tool relevance order and never exposes scores', () => {
    const items = toolItems([tool('2', 'github__merge_pull_request'), tool('1', 'github__create_issue')]);
    expect(items.map((i) => i.label)).toEqual(['github__merge_pull_request', 'github__create_issue']);
    expect(JSON.stringify(items)).not.toContain('0.9');
  });

  it('moves the active row with wrap-around, Home and End', () => {
    expect(moveActive(0, 'ArrowDown', 3)).toBe(1);
    expect(moveActive(2, 'ArrowDown', 3)).toBe(0);
    expect(moveActive(0, 'ArrowUp', 3)).toBe(2);
    expect(moveActive(1, 'Home', 3)).toBe(0);
    expect(moveActive(0, 'End', 3)).toBe(2);
    expect(moveActive(5, '', 3)).toBe(2);
    expect(moveActive(0, 'ArrowDown', 0)).toBe(-1);
  });

  it('recognises ⌘K and Ctrl+K only', () => {
    expect(isPaletteShortcut({ key: 'k', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })).toBe(true);
    expect(isPaletteShortcut({ key: 'K', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false })).toBe(true);
    expect(isPaletteShortcut({ key: 'k', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false })).toBe(false);
    expect(isPaletteShortcut({ key: 'k', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true })).toBe(false);
  });
});

describe('⌘K palette (W8 acceptance)', () => {
  it('opens with Ctrl+K, searches tools, keyboard navigation works and Enter opens the tool’s server', async () => {
    const seen: string[] = [];
    const { user, router } = await renderRoute('/agents', {
      fixtures: {
        'catalog.tools': ({ request }: { request: Request }) => {
          seen.push(new URL(request.url).searchParams.get('q') ?? '');
          return { items: [tool('t1', 'github__merge_pull_request'), tool('t2', 'jira__create_issue', SERVER_IDS.jira)], nextCursor: null };
        },
      },
    });
    await screen.findByRole('heading', { level: 1 });
    await user.keyboard('{Control>}k{/Control}');
    const input = await screen.findByRole('combobox', { name: 'Search pages and tools' });
    expect(input).toHaveFocus();
    await user.type(input, 'merge');
    const list = screen.getByRole('listbox', { name: 'Results' });
    await within(list).findByRole('option', { name: /github__merge_pull_request/ });
    expect(seen.at(-1)).toBe('merge');
    // only tools from the response are shown
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual([
      expect.stringContaining('github__merge_pull_request'),
      expect.stringContaining('jira__create_issue'),
      expect.stringContaining('Search the catalog for “merge”'),
    ]);
    const options = within(list).getAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowDown}');
    expect(input).toHaveAttribute('aria-activedescendant', options[1]!.id);
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(input).toHaveAttribute('aria-activedescendant', options[2]!.id);
    await user.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(router.state.location.pathname).toBe(`/catalog/${SERVER_IDS.github}`));
    expect(screen.queryByRole('combobox', { name: 'Search pages and tools' })).not.toBeInTheDocument();
  });

  it('the top-bar button opens it; pages are filtered by role and the catalog fallback carries q', async () => {
    const { user, router } = await renderRoute('/agents', { me: meFixture('user'), fixtures: { 'catalog.tools': { items: [], nextCursor: null } } });
    await user.click(await screen.findByRole('button', { name: 'Search pages and tools' }));
    const input = await screen.findByRole('combobox', { name: 'Search pages and tools' });
    await user.type(input, 'xyz');
    expect(await screen.findByText('No pages or tools match “xyz”.')).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, 'my req');
    const list = screen.getByRole('listbox', { name: 'Results' });
    expect(within(list).getByRole('option', { name: /My requests/ })).toBeInTheDocument();
    await user.keyboard('{End}');
    await user.keyboard('{Control>}{End}{/Control}{Enter}');
    await waitFor(() => expect(router.state.location.pathname).toBe('/catalog'));
    expect(router.state.location.search).toMatchObject({ view: 'tools', q: 'my req' });
  });
});
