import { screen, waitFor, within } from '@testing-library/react';
import { HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { meFixture } from '@/mocks/fixtures';
import { AUDIT_EVENTS, auditEventFull } from '@/mocks/demo-data';
import { renderRoute } from '@/test/render';
import { auditSearchSchema } from './search';

const EV = AUDIT_EVENTS[2]!; // postgres-analytics__run_query, approved, with redacted params

describe('/audit', () => {
  it('always sends a bounded time range (default 24 h) and renders rows', async () => {
    let seen: URLSearchParams | null = null;
    await renderRoute('/audit', {
      fixtures: {
        'audit.events': ({ request }: { request: Request }) => {
          seen = new URL(request.url).searchParams;
          return { items: AUDIT_EVENTS.slice(0, 5), nextCursor: null };
        },
      },
    });
    const table = await screen.findByRole('table', { name: 'Audit events' });
    expect(await within(table).findByText('internal-docs__search_docs')).toBeInTheDocument();
    const from = Date.parse(seen!.get('from')!);
    const to = Date.parse(seen!.get('to')!);
    expect(to - from).toBe(24 * 3600_000);
    expect(seen!.getAll('kind')).toEqual(['tool_call']);
  });

  it('keeps filters in the URL and sends them to the API', async () => {
    let seen: URLSearchParams | null = null;
    const { router, user } = await renderRoute('/audit?range=7d&decision=denied_acl&agentId=a1', {
      fixtures: {
        'audit.events': ({ request }: { request: Request }) => {
          seen = new URL(request.url).searchParams;
          return { items: [], nextCursor: null };
        },
      },
    });
    expect(await screen.findByText('No events match these filters')).toBeInTheDocument();
    expect(seen!.getAll('decision')).toEqual(['denied_acl']);
    expect(seen!.get('agentId')).toBe('a1');
    expect(Date.parse(seen!.get('to')!) - Date.parse(seen!.get('from')!)).toBe(7 * 24 * 3600_000);
    await user.click(screen.getAllByRole('button', { name: 'Reset filters' })[0]!);
    await waitFor(() => expect((router.state.location.search as Record<string, unknown>).decision).toBeUndefined());
    expect((router.state.location.search as Record<string, unknown>).range).toBe('7d');
  });

  it('drops invalid search params instead of crashing', () => {
    expect(auditSearchSchema.parse({ range: 'nope', decision: ['allowed', 'bogus'], kind: 'x', q: 'ok' })).toMatchObject({ range: undefined, decision: undefined, kind: undefined, q: 'ok' });
    expect(auditSearchSchema.parse({ decision: 'denied_acl' }).decision).toEqual(['denied_acl']);
  });

  it('deep link ?event= opens the drawer; redacted values never show raw content', async () => {
    await renderRoute(`/audit?event=${EV.id}`);
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('REDACTED · secret-values')).toBeInTheDocument();
    expect(within(dialog).getByText('REDACTED · token-keys')).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent('$redacted');
    expect(within(dialog).getByText('18.4 KB')).toBeInTheDocument();
    expect(within(dialog).getByText('Integrity')).toBeInTheDocument();
    expect(auditEventFull(EV.id)!.inputParams).toBeTruthy();
  });

  it('opening a row sets ?event and the export link carries the active filters', async () => {
    const { router, user } = await renderRoute('/audit?range=1h&q=search_code&decision=allowed');
    const table = await screen.findByRole('table', { name: 'Audit events' });
    await user.click((await within(table).findAllByRole('button', { name: 'github__search_code' }))[0]!);
    await waitFor(() => expect((router.state.location.search as { event?: string }).event).toBe(AUDIT_EVENTS[3]!.id));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: /export/i }));
    const csv = await screen.findByRole('menuitem', { name: 'CSV' });
    const href = new URL(csv.getAttribute('href')!, 'http://x');
    expect(href.pathname).toBe('/api/audit/export');
    expect(href.searchParams.get('format')).toBe('csv');
    expect(href.searchParams.get('q')).toBe('search_code');
    expect(href.searchParams.getAll('decision')).toEqual(['allowed']);
    expect(Date.parse(href.searchParams.get('to')!) - Date.parse(href.searchParams.get('from')!)).toBe(3600_000);
  });

  it('verify integrity renders verified and broken-chain results', async () => {
    const broken = {
      id: 'job-verify', kind: 'audit_verify', status: 'succeeded', progress: 1, error: null, createdAt: '2026-11-24T10:00:00.000Z', finishedAt: '2026-11-24T10:00:01.000Z',
      result: { ok: false, checked: 88_211, firstSeq: 1, lastSeq: 88_211, checkpointsVerified: 8, durationMs: 900, brokenAt: { seq: 88_211, eventId: EV.id, reason: 'hash_mismatch', expected: 'sha256:aa', actual: 'sha256:bb' } },
    };
    const { user } = await renderRoute('/audit', { me: meFixture('auditor') });
    await user.click(await screen.findByRole('button', { name: /verify integrity/i }));
    await user.click(await screen.findByRole('button', { name: 'Start verification' }));
    expect(await screen.findByText(/Verified 1,284,113 entries/)).toBeInTheDocument();

    const second = await renderRoute('/audit', { me: meFixture('auditor'), fixtures: { 'jobs.get': () => HttpResponse.json(broken) } });
    await second.user.click((await screen.findAllByRole('button', { name: /verify integrity/i })).at(-1)!);
    await second.user.click(await screen.findByRole('button', { name: 'Start verification' }));
    expect(await screen.findByText(/Chain broken at seq 88,211/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open entry' })).toBeInTheDocument();
  });

  it('owners see the scope notice and no verify button', async () => {
    await renderRoute('/audit', { me: meFixture('owner') });
    expect(await screen.findByText('Showing events for servers you own.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /verify integrity/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /export/i })).toBeInTheDocument();
  });
});
