import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { meFixture } from '@/mocks/fixtures';
import { GROUPS, PEOPLE } from '@/mocks/demo-data';
import { renderRoute } from '@/test/render';
import { createUserBody } from './add-user-dialog';
import { groupPatch } from '@/features/groups/edit-group-dialog';

describe('users admin', () => {
  it('lists users with roles and groups, filters via the URL', async () => {
    let seen: URLSearchParams | null = null;
    const { router, user } = await renderRoute('/admin/users?role=auditor', {
      fixtures: {
        'users.list': ({ request }: { request: Request }) => {
          seen = new URL(request.url).searchParams;
          return { items: [], nextCursor: null };
        },
      },
    });
    expect(await screen.findByText('No users match these filters')).toBeInTheDocument();
    expect(seen!.get('role')).toBe('auditor');
    await user.type(screen.getByRole('searchbox', { name: 'Search users' }), 'dana');
    await waitFor(() => expect((router.state.location.search as { q?: string }).q).toBe('dana'));
  });

  it('opens a user from the list', async () => {
    const { user, router } = await renderRoute('/admin/users');
    const table = await screen.findByRole('table', { name: 'Users' });
    await user.click(await within(table).findByText('Sam Okafor'));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/admin/users/${PEOPLE.sam.id}`));
  });

  it('granting Admin asks for confirmation and PATCHes the roles', async () => {
    let body: unknown;
    const { user } = await renderRoute(`/admin/users/${PEOPLE.sam.id}`, {
      fixtures: {
        'users.update': async ({ request }: { request: Request }) => {
          body = await request.json();
          return { id: PEOPLE.sam.id, email: PEOPLE.sam.email, name: PEOPLE.sam.name, avatarUrl: null, roles: ['admin'], groups: [], status: 'active', lastLoginAt: null, agentCount: 1, agents: [], oidcLinked: true, createdAt: '2026-01-01T00:00:00.000Z', actions: [] };
        },
      },
    });
    await user.click(await screen.findByRole('checkbox', { name: /admin/i }));
    const confirm = await screen.findByRole('alertdialog');
    await user.click(within(confirm).getByRole('button', { name: 'Grant Admin' }));
    await waitFor(() => expect(body).toEqual({ roles: ['admin'] }));
  });

  it("you can't remove your own Admin role; disabling yourself is not offered", async () => {
    await renderRoute(`/admin/users/${PEOPLE.dana.id}`);
    expect(await screen.findByText("You can't remove your own Admin role.")).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /admin/i })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByRole('button', { name: 'Disable user' })).not.toBeInTheDocument();
  });

  it('auditors see users read-only', async () => {
    await renderRoute(`/admin/users/${PEOPLE.sam.id}`, { me: meFixture('auditor') });
    expect(await screen.findByRole('heading', { level: 1, name: 'Sam Okafor' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /admin/i })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByRole('button', { name: /disable user/i })).not.toBeInTheDocument();
    expect(screen.getByText('Read-only')).toBeInTheDocument();
  });

  it('admins pre-provision a user with roles and land on the new user', async () => {
    let body: unknown;
    const { user, router } = await renderRoute('/admin/users', {
      fixtures: {
        'users.create': async ({ request }: { request: Request }) => {
          body = await request.json();
          return (await import('@/mocks/demo-data')).userDetail(PEOPLE.sam.id);
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Add user' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add user' });
    await user.type(within(dialog).getByLabelText('Email'), 'not-an-email');
    await user.click(within(dialog).getByRole('button', { name: 'Add user' }));
    expect(await within(dialog).findByText('Enter a valid email address')).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText('Email'));
    await user.type(within(dialog).getByLabelText('Email'), 'new.person@example.com');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Auditor' }));
    await user.click(within(dialog).getByRole('button', { name: 'Add user' }));
    await waitFor(() => expect(body).toEqual({ email: 'new.person@example.com', roles: ['auditor'] }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/admin/users/${PEOPLE.sam.id}`));
  });

  it('auditors cannot add users; createUserBody drops empty fields', async () => {
    await renderRoute('/admin/users', { me: meFixture('auditor') });
    await screen.findByRole('table', { name: 'Users' });
    expect(screen.queryByRole('button', { name: 'Add user' })).not.toBeInTheDocument();
    expect(createUserBody({ email: ' a@b.co ', name: '  ' }, [])).toEqual({ email: 'a@b.co' });
    expect(createUserBody({ email: 'a@b.co', name: 'Ann' }, ['admin'])).toEqual({ email: 'a@b.co', name: 'Ann', roles: ['admin'] });
  });
});

describe('groups admin', () => {
  it('OIDC group members are read-only; claim mappings list', async () => {
    const { user } = await renderRoute(`/admin/groups/${GROUPS.engineering.id}`);
    expect(await screen.findByText(/synced from your identity provider/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add member' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Claim mappings' }));
    expect(await screen.findByText('okta-engineering')).toBeInTheDocument();
  });

  it('local groups can add members and claim mappings', async () => {
    let mapping: unknown;
    const { user } = await renderRoute(`/admin/groups/${GROUPS.sre.id}?tab=mappings`, {
      fixtures: {
        'groups.createClaimMapping': async ({ request }: { request: Request }) => {
          mapping = await request.json();
          return { id: 'cm9', lastSeenAt: null, ...(mapping as object) };
        },
      },
    });
    await user.type(await screen.findByLabelText('Value'), 'okta-sre');
    await user.click(screen.getByRole('button', { name: 'Add mapping' }));
    await waitFor(() => expect(mapping).toEqual({ claim: 'groups', value: 'okta-sre' }));
  });

  it('edits a local group: only changed fields are PATCHed', async () => {
    let body: unknown;
    const { user } = await renderRoute(`/admin/groups/${GROUPS.sre.id}`, {
      fixtures: { 'groups.update': async ({ request }: { request: Request }) => ((body = await request.json()), { id: GROUPS.sre.id, name: 'sre-oncall', description: 'Site reliability on-call rotation.', source: 'local', memberCount: 12, mappingCount: 0, grantCount: 2 }) },
    });
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit group' });
    const name = within(dialog).getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'sre-oncall');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(body).toEqual({ name: 'sre-oncall' }));
  });

  it('IdP groups: the name is locked, only the description can change', async () => {
    const { user } = await renderRoute(`/admin/groups/${GROUPS.engineering.id}`);
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit group' });
    expect(within(dialog).getByLabelText('Name')).toBeDisabled();
    expect(groupPatch({ name: 'engineering', description: 'a', source: 'oidc' }, { name: 'renamed', description: 'b' })).toEqual({ description: 'b' });
    expect(groupPatch({ name: 'sre', description: 'a', source: 'local' }, { name: 'sre', description: 'a' })).toEqual({});
  });

  it('auditors get no Edit button on groups', async () => {
    await renderRoute(`/admin/groups/${GROUPS.sre.id}`, { me: meFixture('auditor') });
    await screen.findByRole('heading', { level: 1, name: 'sre' });
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('group grants tab reuses the grants table filtered by subject', async () => {
    let seen: URLSearchParams | null = null;
    const { user } = await renderRoute(`/admin/groups/${GROUPS.contractors.id}`, {
      fixtures: {
        'grants.list': ({ request }: { request: Request }) => {
          seen = new URL(request.url).searchParams;
          return { items: [], nextCursor: null };
        },
      },
    });
    await user.click(await screen.findByRole('tab', { name: 'Grants' }));
    await waitFor(() => expect(seen?.get('subjectId')).toBe(GROUPS.contractors.id));
    expect(seen!.get('subjectType')).toBe('group');
  });
});
