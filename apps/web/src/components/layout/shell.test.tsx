import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HttpResponse } from 'msw';
import { meFixture } from '@/mocks/fixtures';
import { renderRoute } from '@/test/render';
import { browserNavigation } from '@/lib/navigation';

describe('app shell', () => {
  it('redirects unauthenticated deep links to the login page with returnTo', async () => {
    const { router } = await renderRoute('/admin/tools?status=pending_review', { me: null });
    await waitFor(() => expect(router.state.location.pathname).toBe('/auth/login'));
    expect((router.state.location.search as { returnTo?: string }).returnTo).toBe('/admin/tools?status=pending_review');
    expect(await screen.findByRole('button', { name: /sign in with okta/i })).toBeInTheDocument();
  });

  it('renders the shell for a user: portal-only sidebar, breadcrumbs, top bar', async () => {
    await renderRoute('/catalog', { me: meFixture('user') });
    const nav = await screen.findByRole('navigation', { name: /main navigation/i }).catch(() => screen.findByLabelText('Main navigation'));
    expect(within(nav).getByRole('link', { name: 'Catalog' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).queryByText('Administration')).not.toBeInTheDocument();
    expect(within(nav).queryByText('Review')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Catalog' })).toBeInTheDocument();
    const crumbs = screen.getByRole('navigation', { name: /breadcrumb/i });
    expect(within(crumbs).getByText('Portal')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /search pages and tools/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /theme:/i })).toBeInTheDocument();
    expect(document.title).toBe('Catalog · Neurouter Hub');
  });

  it('shows role-specific groups and badges for an admin', async () => {
    await renderRoute('/observability', { me: meFixture('admin'), badges: { pendingApprovals: 4 } });
    const nav = screen.getByLabelText('Main navigation');
    for (const label of ['Portal', 'Review', 'Administration', 'Audit & observability', 'Settings']) {
      expect(within(nav).getByText(label)).toBeInTheDocument();
    }
    expect(await within(nav).findByLabelText('4 pending')).toBeInTheDocument();
    expect(within(nav).getByText('Acme Corp')).toBeInTheDocument();
  });

  it('only the longest-prefix item is the current page (Sessions, not Overview)', async () => {
    await renderRoute('/observability/sessions', { me: meFixture('admin') });
    const nav = await screen.findByRole('navigation', { name: 'Main navigation' });
    await waitFor(() => expect(within(nav).getByRole('link', { name: 'Sessions' })).toHaveAttribute('aria-current', 'page'));
    expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(within(nav).getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
  });

  it('on a phone, following a sidebar link closes the sheet', async () => {
    const width = window.innerWidth;
    window.innerWidth = 375;
    try {
      const { user, router } = await renderRoute('/catalog', { me: meFixture('user') });
      await user.click(await screen.findByRole('button', { name: 'Toggle sidebar (Ctrl+B)' }));
      const sheet = await screen.findByRole('dialog');
      await user.click(within(sheet).getByRole('link', { name: 'My agents' }));
      await waitFor(() => expect(router.state.location.pathname).toBe('/agents'));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(await screen.findByRole('heading', { level: 1, name: 'My agents' })).toBeInTheDocument();
    } finally {
      window.innerWidth = width;
    }
  });

  it('the sidebar is a navigation landmark and the page has exactly one main landmark', async () => {
    await renderRoute('/catalog', { me: meFixture('user') });
    const nav = await screen.findByRole('navigation', { name: 'Main navigation' });
    expect(within(nav).getByRole('link', { name: 'Catalog' })).toBeInTheDocument();
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
  });

  it('a count badge keeps its own text colour on the active (and hovered) item', async () => {
    await renderRoute('/admin/approvals', { me: meFixture('admin'), badges: { pendingApprovals: 3 } });
    const [badge] = await within(screen.getByLabelText('Main navigation')).findAllByLabelText('3 pending');
    expect(badge!.closest('li')!.querySelector('a')).toHaveAttribute('data-active');
    // tailwind-merge must drop shadcn's accent-foreground override, which made the count dark on dark
    expect(badge!.className).toContain('peer-data-active/menu-button:text-primary-foreground');
    expect(badge!.className).not.toContain('peer-data-active/menu-button:text-sidebar-accent-foreground');
    expect(badge!.className).not.toContain('peer-hover/menu-button:text-sidebar-accent-foreground');
  });

  it('renders ForbiddenState in place for areas the user cannot access', async () => {
    const { router } = await renderRoute('/admin/users', { me: meFixture('user') });
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/admin/users');
    expect(screen.getByLabelText('Main navigation')).toBeInTheDocument();
  });

  it('blocks server registration for owners but allows their scoped pages', async () => {
    await renderRoute('/admin/servers/new', { me: meFixture('owner') });
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    await renderRoute('/admin/servers', { me: meFixture('owner') });
    expect(await screen.findByRole('heading', { name: 'My servers' })).toBeInTheDocument();
  });

  it('marks admin pages read-only for auditors', async () => {
    await renderRoute('/admin/users', { me: meFixture('auditor') });
    expect(await screen.findByRole('heading', { name: 'Users' })).toBeInTheDocument();
    expect(screen.getByText('Read-only')).toBeInTheDocument();
  });

  it('sends each role to its landing page from /', async () => {
    const admin = await renderRoute('/', { me: meFixture('admin') });
    await waitFor(() => expect(admin.router.state.location.pathname).toBe('/observability'));
    const owner = await renderRoute('/', { me: meFixture('owner'), badges: { pendingApprovals: 2 } });
    await waitFor(() => expect(owner.router.state.location.pathname).toBe('/admin/approvals'));
    const user = await renderRoute('/', { me: meFixture('user') });
    await waitFor(() => expect(user.router.state.location.pathname).toBe('/catalog'));
  });

  it('user menu shows identity, profile links and signs out via the API', async () => {
    let loggedOut = false;
    const { user } = await renderRoute('/catalog', {
      me: meFixture('owner'),
      fixtures: { 'auth.logout': () => { loggedOut = true; return HttpResponse.json({ redirectTo: '/auth/logged-out' }); } },
    });
    const assign = vi.spyOn(browserNavigation, 'assign').mockImplementation(() => {});
    await user.click(screen.getByRole('button', { name: /open user menu/i }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('Marco Ruiz')).toBeInTheDocument();
    expect(within(menu).getByText('marco.ruiz@acme.example')).toBeInTheDocument();
    expect(within(menu).getByText('Server owner · User')).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /profile/i })).toBeInTheDocument();
    await user.click(within(menu).getByRole('menuitem', { name: /sign out/i }));
    await waitFor(() => expect(loggedOut).toBe(true));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/auth/logged-out'));
  });

  it('login page starts OIDC with a sanitized returnTo and shows error messages', async () => {
    const assign = vi.spyOn(browserNavigation, 'assign').mockImplementation(() => {});
    const { user } = await renderRoute('/auth/login?returnTo=%2Fadmin%2Ftools&error=session_expired', { me: null });
    expect(await screen.findByText(/your session expired/i)).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /sign in with okta/i }));
    expect(assign).toHaveBeenCalledWith('/api/auth/login?returnTo=%2Fadmin%2Ftools');
    assign.mockClear();
    cleanup();
    await renderRoute('/auth/login?returnTo=https%3A%2F%2Fevil.com', { me: null });
    await user.click(await screen.findByRole('button', { name: /sign in with okta/i }));
    expect(assign).toHaveBeenCalledWith('/api/auth/login?returnTo=%2F');
  });

  it('shows a not-found page for unknown routes', async () => {
    await renderRoute('/definitely/not/here', { me: meFixture('user') });
    expect(await screen.findByText('Page not found')).toBeInTheDocument();
  });
});
