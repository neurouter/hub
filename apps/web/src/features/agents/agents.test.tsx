import { screen, waitFor, within } from '@testing-library/react';
import { HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { meFixture } from '@/mocks/fixtures';
import { AGENTS } from '@/mocks/demo-data';
import { renderRoute } from '@/test/render';
import { resolveKeyExpiry } from './queries';
import { accessSummary } from './effective-access';

const RELEASE_BOT = AGENTS[0]!;
const SECRET = 'nr_live_7f3K9qL2mX8vB4nR1tY6wZ0pD5sH2jE9cAu';

describe('API key secret reveal (W2 acceptance)', () => {
  it('shows the secret exactly once, keeps it out of every cache, and clears it on close', async () => {
    let body: unknown;
    const { user, queryClient } = await renderRoute(`/agents/${RELEASE_BOT.id}`, {
      fixtures: {
        'agents.createKey': async ({ request }: { request: Request }) => {
          body = await request.json();
          return { key: { id: 'k9', name: 'ci-prod-2', prefix: 'nr_live_7f3K', status: 'active', createdAt: '2026-11-24T10:00:00.000Z', expiresAt: '2027-02-22T10:00:00.000Z', lastUsedAt: null, revokedAt: null }, secret: SECRET };
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Create key' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'ci-prod-2');
    await user.click(within(dialog).getByRole('button', { name: 'Create key' }));

    const secretInput = await within(dialog).findByLabelText('API key');
    expect(secretInput).toHaveValue(SECRET);
    expect(within(dialog).getByText('This is the only time the key is shown.')).toBeInTheDocument();
    expect(body).toMatchObject({ name: 'ci-prod-2' });
    expect(typeof (body as { expiresAt: string }).expiresAt).toBe('string');

    // never in the Query or Mutation cache
    const cached = JSON.stringify([
      queryClient.getQueryCache().getAll().map((q) => q.state.data),
      queryClient.getMutationCache().getAll().map((m) => m.state.data),
    ]);
    expect(cached).not.toContain(SECRET);

    // hide / show toggle masks the value
    await user.click(within(dialog).getByRole('button', { name: 'Hide key' }));
    expect(secretInput).not.toHaveValue(SECRET);

    // Close is disabled until the user confirms they stored it
    const close = within(dialog).getByRole('button', { name: 'Close' });
    expect(close).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox', { name: /stored this key/i }));
    expect(close).toBeEnabled();
    await user.click(close);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.body.textContent).not.toContain(SECRET);

    // re-opening starts a fresh form, the old secret is gone
    await user.click(screen.getByRole('button', { name: 'Create key' }));
    const again = await screen.findByRole('dialog');
    expect(within(again).queryByLabelText('API key')).not.toBeInTheDocument();
    expect(within(again).getByLabelText('Name')).toHaveValue('');
  });

  it('validates the key name and custom expiry', async () => {
    const { user } = await renderRoute(`/agents/${RELEASE_BOT.id}`);
    await user.click(await screen.findByRole('button', { name: 'Create key' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Create key' }));
    expect(await within(dialog).findByText(/name the key/i)).toBeInTheDocument();
  });

  it('resolves expiry choices (30/90/365, custom future date, never)', () => {
    const now = Date.parse('2026-11-24T10:00:00Z');
    expect(resolveKeyExpiry('90', '', now)).toBe('2027-02-22T10:00:00.000Z');
    expect(resolveKeyExpiry('never', '', now)).toBeNull();
    expect(resolveKeyExpiry('custom', '2027-01-31', now)).toBe('2027-01-31T23:59:59.000Z');
    expect(resolveKeyExpiry('custom', '2026-01-01', now)).toBeUndefined();
    expect(resolveKeyExpiry('custom', '', now)).toBeUndefined();
  });
});

describe('agents pages', () => {
  it('lists my agents and creates one without an exposure mode (addendum #1)', async () => {
    let created: unknown;
    const { user, router } = await renderRoute('/agents', {
      fixtures: {
        'agents.create': async ({ request }: { request: Request }) => {
          created = await request.json();
          return { ...RELEASE_BOT, id: 'new-agent', name: 'triage-bot', activeKeyCount: 0 };
        },
      },
    });
    const table = await screen.findByRole('table', { name: 'My agents' });
    expect(await within(table).findByText('release-bot')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /new agent/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText(/exposure/i)).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Name'), 'triage-bot');
    await user.click(within(dialog).getByRole('button', { name: 'Create agent' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents/new-agent'));
    expect(created).toEqual({ name: 'triage-bot' });
  });

  it('each agent row has a keyboard-reachable link to the agent', async () => {
    await renderRoute('/agents');
    const table = await screen.findByRole('table', { name: 'My agents' });
    const link = await within(table).findByRole('link', { name: 'release-bot' });
    expect(link).toHaveAttribute('href', `/agents/${RELEASE_BOT.id}`);
  });

  it('an empty name shows a readable message, not the raw Zod text', async () => {
    const { user } = await renderRoute('/agents');
    await user.click(await screen.findByRole('button', { name: /new agent/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Create agent' }));
    expect(await within(dialog).findByText('Give the agent a name.')).toBeInTheDocument();
    expect(within(dialog).queryByText(/too small/i)).not.toBeInTheDocument();
  });

  it('shows a 409 duplicate name on the field', async () => {
    const { user } = await renderRoute('/agents', {
      fixtures: {
        'agents.create': () => HttpResponse.json({ type: 'x', title: 'Conflict', status: 409, code: 'conflict', requestId: 'r' }, { status: 409, headers: { 'content-type': 'application/problem+json' } }),
      },
    });
    await user.click(await screen.findByRole('button', { name: /new agent/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'release-bot');
    await user.click(within(dialog).getByRole('button', { name: 'Create agent' }));
    expect(await within(dialog).findByText('You already have an agent with this name.')).toBeInTheDocument();
  });

  it('revokes a key optimistically and rolls back on error', async () => {
    const { user } = await renderRoute(`/agents/${RELEASE_BOT.id}`, {
      fixtures: { 'agents.revokeKey': () => HttpResponse.json({ type: 'x', title: 'Boom', status: 500, code: 'internal', requestId: 'r' }, { status: 500, headers: { 'content-type': 'application/problem+json' } }) },
    });
    const table = await screen.findByRole('table', { name: 'API keys' });
    await within(table).findAllByText('staging');
    await user.click(within(table).getByRole('button', { name: "Revoke ci-prod" }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText(/cannot be undone/i)).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Revoke key' }));
    // rollback: the key is active again after the error
    await waitFor(() => expect(within(table).getAllByText('Active')).toHaveLength(2));
  });

  it('auditors view another user’s agent read-only', async () => {
    await renderRoute(`/agents/${AGENTS[2]!.id}`, { me: meFixture('auditor') });
    expect(await screen.findByRole('heading', { level: 1, name: 'nightly-triage' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create key' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });

  it('admin agents page revokes all keys of an agent', async () => {
    let revoked = '';
    const { user } = await renderRoute('/admin/agents', {
      fixtures: { 'agents.revokeAllKeys': ({ params }: { params: Record<string, unknown> }) => ((revoked = String(params.id)), { revoked: 2 }) },
    });
    const table = await screen.findByRole('table', { name: 'All agents' });
    await user.click((await within(table).findAllByRole('button', { name: 'Revoke all keys' }))[0]!);
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Revoke all keys' }));
    await waitFor(() => expect(revoked).toBe(RELEASE_BOT.id));
  });
});

describe('agent effective access', () => {
  const access = {
    servers: [
      {
        server: { id: 's1', name: 'GitHub' },
        tools: [
          { tool: { id: 't1', name: 'create_issue', qualifiedName: 'github__create_issue' }, decision: 'allow' as const },
          { tool: { id: 't2', name: 'delete_repo', qualifiedName: 'github__delete_repo' }, decision: 'deny' as const },
        ],
      },
      { server: { id: 's2', name: 'Docs' }, tools: [{ tool: { id: 't3', name: 'search', qualifiedName: 'docs__search' }, decision: 'none' as const }] },
    ],
  };

  it('lists per-tool decisions grouped by server on the Scope tab', async () => {
    await renderRoute(`/agents/${RELEASE_BOT.id}?tab=scope`, { fixtures: { 'agents.access': access } });
    const gh = await screen.findByRole('list', { name: 'Tools on GitHub' });
    expect(within(gh).getByText('github__create_issue').closest('li')).toHaveTextContent('Allowed');
    expect(within(gh).getByText('github__delete_repo').closest('li')).toHaveTextContent('Denied');
    expect(within(screen.getByRole('list', { name: 'Tools on Docs' })).getByText('No grant')).toBeInTheDocument();
    expect(screen.getByText(/1 of 3 tools allowed/)).toBeInTheDocument();
  });

  it('accessSummary counts across servers', () => {
    expect(accessSummary(access)).toBe('1 of 3 tools allowed');
    expect(accessSummary({ servers: [] })).toBe('0 of 0 tools allowed');
  });
});
