import { screen, waitFor, within } from '@testing-library/react';
import { HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { meFixture } from '@/mocks/fixtures';
import { DOCS_DIFF, TOOL_BY_QN } from '@/mocks/demo-data';
import { renderRoute } from '@/test/render';
import { parseRateLimit } from './policy-panel';
import { reviewTexts } from './review-panel';

const DOCS_SEARCH = TOOL_BY_QN['internal-docs__search_docs']!;
const GH_CREATE = TOOL_BY_QN['github__create_issue']!;
const problem = (status: number, code: string) => () => HttpResponse.json({ type: 'x', title: code, status, code, requestId: 'r' }, { status, headers: { 'content-type': 'application/problem+json' } });

describe('tool definition review (W3)', () => {
  it('opens on Review for a pending tool and shows chips, word diff and sorted-key schema diff', async () => {
    await renderRoute(`/admin/tools/${DOCS_SEARCH.id}`);
    const chips = await screen.findByLabelText('What changed');
    for (const label of ['Description changed', '+1 param · include_drafts', 'limit.maximum 50 → 500', 'readOnlyHint true → false']) {
      expect(within(chips).getByText(label)).toBeInTheDocument();
    }
    expect(within(chips).getByText('readOnlyHint true → false').closest('[data-tone]')).toHaveAttribute('data-tone', 'err');
    expect(screen.getByText(/always call slack__post_message/)).toBeInTheDocument();
    expect(screen.getByText('snippets').tagName).toBe('DEL');
    // schema keys sorted: "default" before "maximum" before "type"
    const added = screen.getAllByText('"include_drafts": {');
    expect(added.length).toBeGreaterThan(0);
  });

  it('a never-pinned tool shows the whole schema as added, not "removed: {}"', async () => {
    const current = { ...DOCS_DIFF.current };
    const diff = { pinned: null, current };
    const t = reviewTexts(diff);
    expect(t.schemaOld).toBe('');
    expect(t.counts.removed).toBe(0);
    expect(t.counts.added).toBe(t.schemaNew.split('\n').filter(Boolean).length);
    await renderRoute(`/admin/tools/${DOCS_SEARCH.id}?tab=review`, { fixtures: { 'tools.definitionDiff': diff } });
    const chips = await screen.findByLabelText('What changed');
    expect(within(chips).getByText('New tool')).toBeInTheDocument();
    expect(screen.getByText('none · first review')).toBeInTheDocument();
    expect(screen.queryByText('{}')).not.toBeInTheDocument();
    expect(screen.queryAllByText('removed:')).toHaveLength(0);
  });

  it('approving sends the reviewed hash', async () => {
    let body: unknown;
    const { user } = await renderRoute(`/admin/tools/${DOCS_SEARCH.id}`, {
      fixtures: { 'tools.approveDefinition': async ({ request }: { request: Request }) => ((body = await request.json()), { ...(await import('@/mocks/demo-data')).toolDetail(DOCS_SEARCH.id)!, reviewState: 'approved', hasPendingChange: false }) },
    });
    await user.click(await screen.findByRole('button', { name: /approve new definition/i }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(DOCS_DIFF.current.hash)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Approve definition' }));
    await waitFor(() => expect(body).toEqual({ hash: DOCS_DIFF.current.hash }));
  });

  it('?tab=review on a tool with nothing pending shows Definition instead of a blank page', async () => {
    await renderRoute(`/admin/tools/${GH_CREATE.id}?tab=review`);
    const definition = await screen.findByRole('tab', { name: 'Definition' });
    expect(screen.queryByRole('tab', { name: /review/i })).not.toBeInTheDocument();
    expect(definition).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: 'Definition' })).toBeInTheDocument();
  });

  it('approving refreshes the server queries (pending-review count in the server header)', async () => {
    const { user, queryClient } = await renderRoute(`/admin/tools/${DOCS_SEARCH.id}`);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await user.click(await screen.findByRole('button', { name: /approve new definition/i }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Approve definition' }));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['servers'] }));
  });

  it('a stale hash (409) asks the reviewer to reload', async () => {
    const { user } = await renderRoute(`/admin/tools/${DOCS_SEARCH.id}`, { fixtures: { 'tools.approveDefinition': problem(409, 'conflict') } });
    await user.click(await screen.findByRole('button', { name: /approve new definition/i }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Approve definition' }));
    expect(await screen.findByText(/definition changed again since you opened it/i)).toBeInTheDocument();
  });

  it('auditors can read the review but not decide', async () => {
    await renderRoute(`/admin/tools/${DOCS_SEARCH.id}`, { me: meFixture('auditor') });
    expect(await screen.findByLabelText('What changed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve new definition/i })).not.toBeInTheDocument();
  });

  it('layout toggles between split and unified', async () => {
    const { user } = await renderRoute(`/admin/tools/${DOCS_SEARCH.id}`);
    const toggle = await screen.findByRole('radiogroup', { name: 'Diff layout' });
    expect(within(toggle).getByRole('radio', { name: 'Split' })).toHaveAttribute('aria-checked', 'true');
    await user.click(within(toggle).getByRole('radio', { name: 'Unified' }));
    expect(screen.getAllByRole('group', { name: 'Unified diff' }).length).toBeGreaterThan(0);
  });
});

describe('tools list', () => {
  it('flips the enabled switch optimistically and rolls back on error', async () => {
    const { user } = await renderRoute('/admin/tools', { fixtures: { 'tools.update': problem(500, 'internal') } });
    const sw = await screen.findByRole('switch', { name: `Enabled: ${GH_CREATE.qualifiedName}` });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    await user.click(sw);
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'));
  });

  it('pending-review tools cannot be enabled inline', async () => {
    await renderRoute('/admin/tools?status=pending_review');
    expect(await screen.findByRole('switch', { name: `Enabled: ${DOCS_SEARCH.qualifiedName}` })).toHaveAttribute('aria-disabled', 'true');
  });

  it('bulk-requires approval for the selected tools', async () => {
    let body: unknown;
    const { user } = await renderRoute('/admin/tools', { fixtures: { 'tools.bulk': async ({ request }: { request: Request }) => ((body = await request.json()), { updated: 2, skipped: [] }) } });
    await user.click(await screen.findByRole('checkbox', { name: `Select ${GH_CREATE.qualifiedName}` }));
    await user.click(screen.getByRole('checkbox', { name: 'Select github__search_code' }));
    const bar = screen.getByRole('region', { name: 'Bulk actions' });
    expect(within(bar).getByText('2 tools selected')).toBeInTheDocument();
    await user.click(within(bar).getByRole('button', { name: 'Require approval' }));
    await waitFor(() => expect(body).toEqual({ ids: [GH_CREATE.id, TOOL_BY_QN['github__search_code']!.id], patch: { requiresApproval: true } }));
  });

  it('parses the per-tool rate-limit override (empty = inherit)', () => {
    expect(parseRateLimit('', '')).toEqual({ value: null });
    expect(parseRateLimit('30', '10')).toEqual({ value: { perMinute: 30, burst: 10 } });
    expect(parseRateLimit('30', '')).toHaveProperty('error');
    expect(parseRateLimit('0', '1')).toHaveProperty('error');
  });
});

describe('tool definition history', () => {
  it('shows every hash with its decision and marks the pinned one', async () => {
    const pinned = 'sha256:aaaaaaaaaaaaaaaaaaaa';
    const versions = [
      { id: 'v2', hash: 'sha256:bbbbbbbbbbbbbbbbbbbb', firstSeenAt: '2026-11-21T00:00:00.000Z', decision: 'rejected', decidedBy: { id: 'u', name: 'Dana' }, decidedAt: '2026-11-21T01:00:00.000Z' },
      { id: 'v1', hash: pinned, firstSeenAt: '2026-11-01T00:00:00.000Z', decision: 'approved', decidedBy: null, decidedAt: '2026-11-01T00:00:00.000Z' },
    ];
    const detail = { ...(await import('@/mocks/demo-data')).toolDetail(GH_CREATE.id)!, pinnedHash: pinned };
    await renderRoute(`/admin/tools/${GH_CREATE.id}?tab=definition`, { fixtures: { 'tools.get': detail, 'tools.versions': { items: versions, nextCursor: null } } });
    await screen.findAllByText('Rejected');
    const table = screen.getByRole('table', { name: 'Definition history' });
    expect(within(table).getByText('Approved')).toBeInTheDocument();
    expect(within(table).getByText('Pinned')).toBeInTheDocument();
    expect(within(table).getByText(/· Dana/)).toBeInTheDocument();
  });
});
