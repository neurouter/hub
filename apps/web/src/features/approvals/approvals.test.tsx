import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROBLEM_CONTENT_TYPE, problemType, type Approval } from '@neurouter/shared';
import { TooltipProvider } from '@/components/ui/tooltip';
import { meFixture } from '@/mocks/fixtures';
import { APPROVALS, NOW, PEOPLE, RESOLVED_APPROVALS } from '@/mocks/demo-data';
import { createFakeTransport, liveTransport } from '@/lib/live';
import { renderRoute } from '@/test/render';
import { ApprovalCard } from './approval-card';
import {
  applyApprovalEvent, approvalKeys, clientLabel, countdown, crossedThreshold, decisionLatencyMs, formatClock, outcomeLabel, removeApproval,
  sortBySoonestExpiry, spokenRemaining, upsertApproval, type ApprovalPage,
} from './model';

const page = (items: Approval[]): ApprovalPage => ({ items, nextCursor: null });
const problem = (status: number, code: string, title: string) =>
  HttpResponse.json({ type: problemType(code), title, status, code, requestId: 't' }, { status, headers: { 'content-type': PROBLEM_CONTENT_TYPE } });

describe('countdown model', () => {
  const exp = new Date(NOW + 300_000).toISOString();

  it('formats m:ss and computes urgency thresholds from the server clock', () => {
    expect(formatClock(287)).toBe('4:47');
    expect(countdown(exp, 300, NOW)).toMatchObject({ leftSec: 300, label: '5:00', pct: 100, urgency: 'normal' });
    expect(countdown(exp, 300, NOW + 241_000)).toMatchObject({ leftSec: 59, urgency: 'warning' });
    expect(countdown(exp, 300, NOW + 286_000)).toMatchObject({ leftSec: 14, urgency: 'critical' });
    expect(countdown(exp, 300, NOW + 300_000)).toMatchObject({ leftSec: 0, label: 'Expired', pct: 0, urgency: 'expired' });
    // a 30 s server offset shortens the visible window accordingly
    expect(countdown(exp, 300, NOW + 30_000).label).toBe('4:30');
  });

  it('announces only when crossing 60 s and 15 s', () => {
    expect(crossedThreshold(undefined, 59)).toBeNull();
    expect(crossedThreshold(61, 60)).toBe(60);
    expect(crossedThreshold(60, 59)).toBeNull();
    expect(crossedThreshold(16, 15)).toBe(15);
    expect(crossedThreshold(1, 0)).toBeNull();
    expect(spokenRemaining(200)).toBe('3 minutes 20 seconds left');
    expect(spokenRemaining(60)).toBe('1 minute left');
  });

  it('labels the client, the outcome and the decision latency', () => {
    expect(clientLabel(APPROVALS[0]!)).toBe('API key · release-bot');
    expect(clientLabel({ ...APPROVALS[0]!, apiKey: { id: 'k1', name: 'ci-runner' } })).toBe('API key “ci-runner” · release-bot');
    expect(clientLabel({ ...APPROVALS[0]!, apiKey: null })).toBe('API key · release-bot');
    expect(clientLabel(APPROVALS[1]!)).toBe('Claude Code 2.4');
    expect(outcomeLabel({ status: 'approved', decidedBy: { id: 'x', name: 'Bob' } })).toBe('Approved by Bob');
    expect(outcomeLabel({ status: 'expired', decidedBy: null })).toMatch(/^Expired/);
    expect(outcomeLabel({ status: 'pending', decidedBy: null })).toBeNull();
    expect(decisionLatencyMs(RESOLVED_APPROVALS[0]!)).toBe(38_000);
  });

  it('sorts by soonest expiry and edits pages immutably', () => {
    const sorted = sortBySoonestExpiry([APPROVALS[3]!, APPROVALS[0]!, APPROVALS[2]!]);
    expect(sorted.map((a) => a.id)).toEqual([APPROVALS[0]!.id, APPROVALS[2]!.id, APPROVALS[3]!.id]);
    const p = page([APPROVALS[0]!]);
    expect(upsertApproval(p, APPROVALS[1]!)!.items.map((a) => a.id)).toEqual([APPROVALS[1]!.id, APPROVALS[0]!.id]);
    expect(removeApproval(p, APPROVALS[0]!.id)!.items).toEqual([]);
    expect(removeApproval(p, 'nope')).toBe(p);
  });

  it('applies SSE events to the pending cache (created → insert, resolved → outcome, then removal)', () => {
    const qc = new QueryClient();
    const key = approvalKeys.list('pending', { limit: 200 });
    qc.setQueryData(key, page([APPROVALS[0]!]));
    const scheduled: (() => void)[] = [];
    applyApprovalEvent(qc, 'approval.created', APPROVALS[1], (fn) => scheduled.push(fn));
    expect(qc.getQueryData<ApprovalPage>(key)!.items).toHaveLength(2);
    applyApprovalEvent(qc, 'approval.resolved', { ...APPROVALS[0]!, status: 'approved', decidedBy: { id: PEOPLE.marco.id, name: 'Bob' } }, (fn) => scheduled.push(fn));
    expect(qc.getQueryData<ApprovalPage>(key)!.items.find((a) => a.id === APPROVALS[0]!.id)!.status).toBe('approved');
    scheduled.forEach((fn) => fn());
    expect(qc.getQueryData<ApprovalPage>(key)!.items.map((a) => a.id)).toEqual([APPROVALS[1]!.id]);
    expect(applyApprovalEvent(qc, 'approval.created', { bogus: true })).toBeNull();
  });
});

describe('ApprovalCard', () => {
  const renderCard = (cd: ReturnType<typeof countdown>, a: Approval = APPROVALS[2]!) => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    render(
      <TooltipProvider>
        <ApprovalCard approval={a} cd={cd} compact={false} pending={false} onApprove={onApprove} onDeny={onDeny} />
      </TooltipProvider>,
    );
    return { onApprove, onDeny, user: userEvent.setup() };
  };

  it('shows the countdown, progress and redacted params; deny requires a reason', async () => {
    const { onDeny, user } = renderCard(countdown(APPROVALS[2]!.expiresAt, 300, NOW));
    expect(screen.getByRole('heading', { name: 'slack__post_message' })).toBeInTheDocument();
    expect(screen.getByText('3:41')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '221');
    expect(screen.getByText(/REDACTED · token-keys/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Deny slack__post_message' }));
    const confirm = screen.getByRole('button', { name: 'Deny call to slack__post_message' });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText(/Reason for denying/), 'Freeze until Thursday');
    await user.click(confirm);
    expect(onDeny).toHaveBeenCalledWith('Freeze until Thursday');
  });

  it('marks warning and critical urgency and disables both actions at 0', () => {
    const a = APPROVALS[2]!;
    const exp = Date.parse(a.expiresAt);
    const { unmount } = render(<ApprovalCard approval={a} cd={countdown(a.expiresAt, 300, exp - 30_000)} compact={false} pending={false} onApprove={() => {}} onDeny={() => {}} />);
    expect(screen.getByRole('article')).toHaveAttribute('data-urgency', 'warning');
    unmount();
    const r = render(<ApprovalCard approval={a} cd={countdown(a.expiresAt, 300, exp - 9_000)} compact={false} pending={false} onApprove={() => {}} onDeny={() => {}} />);
    expect(screen.getByRole('article')).toHaveAttribute('data-urgency', 'critical');
    r.unmount();
    render(<ApprovalCard approval={a} cd={countdown(a.expiresAt, 300, exp)} compact={false} pending={false} onApprove={() => {}} onDeny={() => {}} />);
    expect(screen.getByText('Expired · the agent received a timeout error')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve slack__post_message' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Deny slack__post_message' })).toBeDisabled();
  });

  it("disables Approve for the requester's own call (actions lacks approve)", () => {
    renderCard(countdown(APPROVALS[3]!.expiresAt, 300, NOW), APPROVALS[3]!);
    expect(screen.getByRole('button', { name: 'Approve jira__create_issue' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Deny jira__create_issue' })).toBeEnabled();
  });
});

describe('/admin/approvals (W9 acceptance)', () => {
  let fake: ReturnType<typeof createFakeTransport>;
  const original = liveTransport.create;
  beforeEach(() => {
    fake = createFakeTransport();
    liveTransport.create = fake.create;
  });
  afterEach(() => {
    liveTransport.create = original;
  });

  it('lists pending calls by soonest expiry with a Live badge once the stream opens', async () => {
    await renderRoute('/admin/approvals');
    const list = await screen.findByRole('list', { name: 'Pending approvals' });
    const headings = within(list).getAllByRole('heading').map((h) => h.textContent);
    expect(headings).toEqual(['github__merge_pull_request', 'postgres-analytics__run_query', 'slack__post_message', 'jira__create_issue']);
    expect(fake.last().url).toBe('/api/approvals/stream');
    expect(screen.getByText('Connecting…')).toBeInTheDocument();
    act(() => fake.last().open());
    expect(await screen.findByText('Live')).toBeInTheDocument();
    expect(within(list).getByText(/API key · release-bot/)).toBeInTheDocument();
  });

  it('a fake channel drives created / resolved-elsewhere / expired', async () => {
    await renderRoute('/admin/approvals', { fixtures: { 'approvals.list': page([APPROVALS[2]!, APPROVALS[3]!]) } });
    const list = await screen.findByRole('list', { name: 'Pending approvals' });
    act(() => fake.last().open());

    act(() => fake.last().emit('approval.created', APPROVALS[0]));
    expect(await within(list).findByRole('heading', { name: 'github__merge_pull_request' })).toBeInTheDocument();
    expect(await screen.findByText('New approval request for github__merge_pull_request')).toBeInTheDocument();

    act(() => fake.last().emit('approval.resolved', { ...APPROVALS[2]!, status: 'approved', decidedBy: { id: PEOPLE.marco.id, name: 'Bob' }, actions: [] }));
    expect(await within(list).findByText('Approved by Bob')).toBeInTheDocument();
    act(() => fake.last().emit('approval.expired', { ...APPROVALS[3]!, status: 'expired', actions: [] }));
    expect(await within(list).findByText(/^Expired · the agent/)).toBeInTheDocument();
    // both leave after the 3 s linger
    await waitFor(
      () => {
        expect(within(list).queryByRole('heading', { name: 'slack__post_message' })).not.toBeInTheDocument();
        expect(within(list).queryByRole('heading', { name: 'jira__create_issue' })).not.toBeInTheDocument();
      },
      { timeout: 4500 },
    );
  });

  it('?id= highlights a linked pending approval in the list', async () => {
    await renderRoute(`/admin/approvals?id=${APPROVALS[2]!.id}`, { fixtures: { 'approvals.list': page([APPROVALS[2]!, APPROVALS[3]!]) } });
    const list = await screen.findByRole('list', { name: 'Pending approvals' });
    const focused = list.querySelector('[data-focused]');
    expect(focused).not.toBeNull();
    expect(within(focused as HTMLElement).getByRole('heading', { name: 'slack__post_message' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Linked approval' })).not.toBeInTheDocument();
  });

  it('?id= of a resolved approval shows it on its own (approvals.get); Show all clears it', async () => {
    const resolved = RESOLVED_APPROVALS[0]!;
    const { user, router } = await renderRoute(`/admin/approvals?id=${resolved.id}`, { fixtures: { 'approvals.list': page([APPROVALS[2]!]) } });
    const linked = await screen.findByRole('region', { name: 'Linked approval' });
    expect(await within(linked).findByRole('heading', { name: resolved.tool.qualifiedName })).toBeInTheDocument();
    await user.click(within(linked).getByRole('button', { name: 'Show all' }));
    await waitFor(() => expect(router.state.location.search).toEqual({}));
  });

  it('?id= that is unknown says so', async () => {
    await renderRoute('/admin/approvals?id=nope', { fixtures: { 'approvals.list': page([APPROVALS[2]!]), 'approvals.get': () => problem(404, 'not_found', 'Not found') } });
    expect(await screen.findByText(/doesn’t exist or isn’t visible to you/)).toBeInTheDocument();
  });

  it('switches to polling (badge) when the channel is degraded', async () => {
    await renderRoute('/admin/approvals');
    await screen.findByRole('list', { name: 'Pending approvals' });
    act(() => {
      fake.last().error();
      fake.last().error();
      fake.last().error();
    });
    expect(await screen.findByText('Polling every 5 s')).toBeInTheDocument();
  });

  it('approve removes the card optimistically and toasts', async () => {
    const approve = vi.fn(() => ({ ...APPROVALS[2]!, status: 'approved', actions: [] }));
    const { user } = await renderRoute('/admin/approvals', { fixtures: { 'approvals.list': page([APPROVALS[2]!]), 'approvals.approve': approve } });
    await user.click(await screen.findByRole('button', { name: 'Approve slack__post_message' }));
    expect(screen.queryByRole('heading', { name: 'slack__post_message' })).not.toBeInTheDocument();
    expect(await screen.findByText('Approved slack__post_message')).toBeInTheDocument();
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it('409 keeps the card removed and says it was already handled; other errors roll back', async () => {
    const r = await renderRoute('/admin/approvals', {
      fixtures: { 'approvals.list': page([APPROVALS[2]!]), 'approvals.approve': () => problem(409, 'conflict', 'Approval already resolved') },
    });
    await r.user.click(await screen.findByRole('button', { name: 'Approve slack__post_message' }));
    expect(await screen.findByText('Already handled')).toBeInTheDocument();
    r.unmount();

    const r2 = await renderRoute('/admin/approvals', {
      fixtures: { 'approvals.list': page([APPROVALS[2]!]), 'approvals.approve': () => problem(500, 'internal', 'Internal error') },
    });
    await r2.user.click(await screen.findByRole('button', { name: 'Approve slack__post_message' }));
    expect(await screen.findByText('Could not record the decision')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'slack__post_message' })).toBeInTheDocument();
  });

  it('deny posts the reason', async () => {
    let sent: unknown;
    const { user } = await renderRoute('/admin/approvals', {
      fixtures: {
        'approvals.list': page([APPROVALS[2]!]),
        'approvals.deny': async ({ request }: { request: Request }) => {
          sent = await request.json();
          return { ...APPROVALS[2]!, status: 'denied', actions: [] };
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Deny slack__post_message' }));
    await user.type(screen.getByLabelText(/Reason for denying/), 'Not now');
    await user.click(screen.getByRole('button', { name: 'Deny call to slack__post_message' }));
    expect(await screen.findByText('Denied slack__post_message')).toBeInTheDocument();
    expect(sent).toEqual({ reason: 'Not now' });
  });

  it('empty state and Recent decisions tab', async () => {
    const { user } = await renderRoute('/admin/approvals', { fixtures: { 'approvals.list': (c: { request: Request }) => page(new URL(c.request.url).searchParams.get('status') === 'resolved' ? RESOLVED_APPROVALS : []) } });
    expect(await screen.findByText('No pending approvals')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Recent decisions' }));
    const table = await screen.findByRole('table', { name: 'Recent decisions' });
    expect(within(table).getAllByText('Approved')).toHaveLength(2);
    expect(within(table).getByText('Timed out')).toBeInTheDocument();
    expect(within(table).getByText('38.0 s')).toBeInTheDocument();
  });

  it('a server owner sees the owned-servers note', async () => {
    await renderRoute('/admin/approvals', { me: meFixture('owner') });
    expect(await screen.findByText(/Showing calls to servers you own/)).toBeInTheDocument();
  });

  it('375 px: compact cards (bar on top, "agent for user", two-column actions)', async () => {
    const width = window.innerWidth;
    window.innerWidth = 375;
    try {
      await renderRoute('/admin/approvals', { me: meFixture('owner'), fixtures: { 'approvals.list': page([APPROVALS[0]!]) } });
      const card = (await screen.findByRole('heading', { name: 'github__merge_pull_request' })).closest('article') as HTMLElement;
      await waitFor(() => expect(card.firstElementChild).toHaveAttribute('role', 'progressbar'));
      expect(card.textContent).toContain('release-bot for Dana Whitfield');
      expect(within(card).queryByText('Requires approval')).not.toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Recent' })).toBeInTheDocument();
    } finally {
      window.innerWidth = width;
    }
  });
});
