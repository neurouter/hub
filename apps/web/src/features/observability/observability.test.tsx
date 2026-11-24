import { screen, waitFor, within } from '@testing-library/react';
import { HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { SERVER_IDS, SESSIONS, breakdown, metricsSummary, sessionDetail, timeseries } from '@/mocks/demo-data';
import { renderRoute } from '@/test/render';
import { autoRefreshDefault } from '@/routes/_app/observability/index';

const fail = () => HttpResponse.json({ type: 'x', title: 'Metrics unavailable', status: 503, code: 'service_unavailable', requestId: 'r' }, { status: 503, headers: { 'content-type': 'application/problem+json' } });

describe('/observability', () => {
  it('renders KPIs with good/bad delta semantics and picks the chart interval', async () => {
    let interval: string | null = null;
    await renderRoute('/observability?range=7d', {
      fixtures: {
        'metrics.timeseries': ({ request }: { request: Request }) => {
          const p = new URL(request.url).searchParams;
          interval = p.get('interval');
          return timeseries(p.get('from')!, p.get('to')!, '1h');
        },
      },
    });
    const calls = await screen.findByRole('region', { name: 'Calls' });
    expect(await within(calls).findByText('184,302')).toBeInTheDocument();
    const blocked = screen.getByRole('region', { name: 'Blocked' });
    expect(within(blocked).getByText('(worse)')).toBeInTheDocument();
    const err = screen.getByRole('region', { name: 'Error rate' });
    expect(within(err).getByText('(better)')).toBeInTheDocument();
    await waitFor(() => expect(interval).toBe('1h'));
    expect(screen.getAllByText('vs previous 7d').length).toBeGreaterThan(0);
  });

  it('clicking a breakdown row adds a scope filter that every widget uses', async () => {
    const seen: Record<string, string | null> = {};
    const track = (name: string, fn: (p: URLSearchParams) => unknown) => ({ request }: { request: Request }) => {
      const p = new URL(request.url).searchParams;
      seen[name] = p.get('serverId');
      return fn(p);
    };
    const { user, router } = await renderRoute('/observability', {
      fixtures: {
        'metrics.summary': track('summary', () => metricsSummary()),
        'metrics.timeseries': track('series', (p) => timeseries(p.get('from')!, p.get('to')!, '15m')),
        'metrics.breakdown': track('breakdown', (p) => breakdown(p.get('dimension')!)),
      },
    });
    const table = await screen.findByRole('table', { name: 'Breakdown by server' });
    await user.click(await within(table).findByRole('button', { name: 'Filter by jira' }));
    await waitFor(() => expect((router.state.location.search as { serverId?: string }).serverId).toBe(SERVER_IDS.jira));
    await waitFor(() => expect(seen).toEqual({ summary: SERVER_IDS.jira, series: SERVER_IDS.jira, breakdown: SERVER_IDS.jira }));
    expect(screen.getByRole('button', { name: /Server: jira/ })).toBeInTheDocument();
  });

  it('a failing widget shows its own error while the rest render', async () => {
    await renderRoute('/observability', { fixtures: { 'metrics.timeseries': fail } });
    expect((await screen.findAllByText('Metrics unavailable')).length).toBe(2);
    expect(await screen.findByText('184,302')).toBeInTheDocument();
    expect(await screen.findByRole('table', { name: 'Breakdown by server' })).toBeInTheDocument();
  });

  it('charts offer a table view and an accessible summary', async () => {
    const { user } = await renderRoute('/observability');
    expect(await screen.findByRole('img', { name: /Calls over time: [\d,]+ total, peak/ })).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'View as table' })[0]!);
    expect(await screen.findByRole('table', { name: 'Calls over time' })).toBeInTheDocument();
  });

  it('auto-refresh defaults on only for ranges ≤ 24 h', () => {
    expect(autoRefreshDefault('1h')).toBe(true);
    expect(autoRefreshDefault('24h')).toBe(true);
    expect(autoRefreshDefault('7d')).toBe(false);
    expect(autoRefreshDefault('custom')).toBe(false);
  });
});

describe('sessions', () => {
  it('active-only filter is sent and rows link to the timeline', async () => {
    let active: string | null = null;
    const { user, router } = await renderRoute('/observability/sessions?active=true', {
      fixtures: { 'sessions.list': ({ request }: { request: Request }) => ((active = new URL(request.url).searchParams.get('active')), { items: [SESSIONS[0]], nextCursor: null }) },
    });
    const table = await screen.findByRole('table', { name: 'Sessions' });
    expect(await within(table).findByText('Active')).toBeInTheDocument();
    expect(active).toBe('true');
    await user.click(within(table).getByText('claude-code @ priya'));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/observability/sessions/${SESSIONS[0]!.id}`));
  });

  it('timeline shows offsets, idle separators and opens the audit drawer', async () => {
    const s = SESSIONS[0]!;
    const { user, router } = await renderRoute(`/observability/sessions/${s.id}`, { fixtures: { 'sessions.get': { ...sessionDetail(s.id)!, active: false } } });
    const list = await screen.findByRole('list', { name: 'Session calls' });
    expect(await within(list).findByText('+8.1 s')).toBeInTheDocument();
    expect(within(list).getByText(/17 min idle/)).toBeInTheDocument();
    await user.click(within(list).getAllByRole('button', { name: /View event postgres-analytics__run_query/ })[0]!);
    await waitFor(() => expect((router.state.location.search as { event?: string }).event).toBeTruthy());
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});
