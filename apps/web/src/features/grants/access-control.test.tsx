import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { meFixture } from '@/mocks/fixtures';
import { GRANTS, GROUPS, SERVER_IDS, TOOL_BY_QN } from '@/mocks/demo-data';
import { renderRoute } from '@/test/render';
import { explainReason } from './check-access-sheet';

const MATRIX = `/admin/access-control?view=matrix&server=${SERVER_IDS.github}`;

afterEach(() => {
  window.innerWidth = 1024;
});

describe('/admin/access-control', () => {
  it('lists grants with effect shown as icon + text (not colour alone)', async () => {
    await renderRoute('/admin/access-control');
    const table = await screen.findByRole('table', { name: 'Grants' });
    const deny = (await within(table).findAllByText('Deny'))[0]!;
    const allow = within(table).getAllByText('Allow')[0]!;
    expect(deny.closest('[data-tone]')).toHaveAttribute('data-tone', 'err');
    expect(deny.closest('[data-tone]')!.querySelector('svg')).not.toBeNull();
    expect(allow.closest('[data-tone]')!.querySelector('svg')).not.toBeNull();
  });

  it('matrix: tri-state edits batch into ONE request; Discard restores', async () => {
    const calls: unknown[] = [];
    const { user } = await renderRoute(MATRIX, {
      fixtures: {
        'grants.batch': async ({ request }: { request: Request }) => {
          calls.push(await request.json());
          return { created: 1, updated: 0, deleted: 1 };
        },
      },
    });
    const table = await screen.findByRole('table', { name: /access matrix for/i });
    const delCell = await within(table).findByRole('radiogroup', { name: 'group:contractors on github__delete_branch' });
    expect(within(delCell).getByRole('radio', { name: 'Deny' })).toHaveAttribute('aria-checked', 'true');
    await user.click(within(delCell).getByRole('radio', { name: 'Inherit' }));
    const createCell = within(table).getByRole('radiogroup', { name: 'group:sre on github__create_issue' });
    await user.click(within(createCell).getByRole('radio', { name: 'Allow' }));

    const footer = screen.getByRole('region', { name: 'Staged changes' });
    expect(within(footer).getByText('2 changes staged')).toBeInTheDocument();

    await user.click(within(footer).getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('region', { name: 'Staged changes' })).not.toBeInTheDocument();
    expect(within(delCell).getByRole('radio', { name: 'Deny' })).toHaveAttribute('aria-checked', 'true');

    await user.click(within(delCell).getByRole('radio', { name: 'Inherit' }));
    await user.click(within(createCell).getByRole('radio', { name: 'Allow' }));
    await user.click(within(screen.getByRole('region', { name: 'Staged changes' })).getByRole('button', { name: /review/i }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getAllByRole('listitem')).toHaveLength(2);
    await user.click(within(sheet).getByRole('button', { name: 'Save 2 changes' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    const delGrant = GRANTS.find((g) => g.subject.id === GROUPS.contractors.id && g.target.id === TOOL_BY_QN['github__delete_branch']!.id)!;
    expect(calls[0]).toEqual({
      deletes: [delGrant.id],
      upserts: [{ subject: { type: 'group', id: GROUPS.sre.id }, target: { type: 'tool', id: TOOL_BY_QN['github__create_issue']!.id }, effect: 'allow' }],
    });
  });

  it('matrix shows inherited access from a server-wide grant as a muted badge', async () => {
    await renderRoute(MATRIX);
    const table = await screen.findByRole('table', { name: /access matrix for/i });
    expect((await within(table).findAllByLabelText('Inherited allow server-wide grant on github')).length).toBeGreaterThan(0);
  });

  it('column search narrows tool columns and keeps the server column', async () => {
    const { user } = await renderRoute(MATRIX);
    const table = await screen.findByRole('table', { name: /access matrix for/i });
    await within(table).findAllByRole('columnheader');
    await user.type(screen.getByRole('searchbox', { name: 'Filter tool columns' }), 'merge');
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Subject', 'Server (all tools)', 'merge_pull_requestapproval']);
  });

  it('falls back to the list below 1024 px', async () => {
    window.innerWidth = 800;
    await renderRoute(MATRIX);
    expect(await screen.findByText(/matrix view needs a screen at least 1024 px/i)).toBeInTheDocument();
    expect(await screen.findByRole('table', { name: 'Grants' })).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: /access matrix/i })).not.toBeInTheDocument();
  });

  it('auditors see the matrix read-only and no Add grant', async () => {
    await renderRoute(MATRIX, { me: meFixture('auditor') });
    const table = await screen.findByRole('table', { name: /access matrix for/i });
    const cell = await within(table).findByRole('radiogroup', { name: 'group:contractors on github__delete_branch' });
    expect(within(cell).getByRole('radio', { name: 'Allow' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /add grant/i })).not.toBeInTheDocument();
  });

  it('check access renders the decision and the reasons chain (deny first)', async () => {
    const { user } = await renderRoute(`/admin/access-control?check=user&subjectId=u1`);
    const sheet = await screen.findByRole('dialog');
    await user.click(within(sheet).getByRole('button', { name: 'Server' }));
    await user.click(await screen.findByRole('option', { name: /github/ }));
    expect(await within(sheet).findByText('Denied')).toBeInTheDocument();
    const reasons = within(sheet).getByRole('list', { name: 'Reasons' });
    expect(within(reasons).getAllByRole('listitem')[0]).toHaveTextContent('Denied by group:contractors deny on github__delete_branch');
    expect(explainReason(GRANTS.map((g) => ({ grantId: g.id, subject: g.subject, target: g.target, effect: g.effect }))[0]!)).toBe('Allowed by group:engineering allow on server github');
  });
});
