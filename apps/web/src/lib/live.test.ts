import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeTransport, createLiveChannel, type LiveStatus } from './live';
import { computeOffset, serverClock } from './server-time';

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => {
  vi.useRealTimers();
  setHidden(false);
});

describe('createLiveChannel', () => {
  it('reports open, parses events and passes the last event id', () => {
    const t = createFakeTransport();
    const onEvent = vi.fn();
    const statuses: LiveStatus[] = [];
    const ch = createLiveChannel('/api/approvals/stream', { events: ['approval.created'], onEvent, onStatus: (s) => statuses.push(s) }, t);
    expect(t.last().url).toBe('/api/approvals/stream');
    t.last().open();
    t.last().emit('approval.created', { id: 'a1' }, '17:a1');
    t.last().emit('approval.created', 'not json{');
    t.last().emit('other.event', { id: 'x' });
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith('approval.created', { id: 'a1' }, '17:a1');
    expect(statuses).toEqual(['connecting', 'open']);
    ch.close();
    expect(t.last().closed).toBe(true);
    expect(ch.status()).toBe('closed');
  });

  it('degrades after 3 consecutive errors and recovers when the stream reopens', () => {
    const t = createFakeTransport();
    const ch = createLiveChannel('/s', { events: [], onEvent: () => {} }, t);
    t.last().open();
    t.last().error();
    t.last().error();
    expect(ch.status()).toBe('connecting');
    t.last().error();
    expect(ch.status()).toBe('degraded');
    t.last().open();
    expect(ch.status()).toBe('open');
    ch.close();
  });

  it('re-creates the EventSource after retryMs when the browser closed it', () => {
    vi.useFakeTimers();
    const t = createFakeTransport();
    const ch = createLiveChannel('/s', { events: [], onEvent: () => {}, retryMs: 1000 }, t);
    t.last().error({ closed: true });
    expect(t.sources).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(t.sources).toHaveLength(2);
    ch.close();
  });

  it('is degraded at once when the platform has no EventSource', () => {
    const ch = createLiveChannel('/s', { events: [], onEvent: () => {} }, { create: null });
    expect(ch.status()).toBe('degraded');
    ch.close();
  });

  it('pauses after being hidden for hiddenPauseMs and resumes (with onResume) when visible', () => {
    vi.useFakeTimers();
    const t = createFakeTransport();
    const onResume = vi.fn();
    const ch = createLiveChannel('/s', { events: [], onEvent: () => {}, onResume, hiddenPauseMs: 60_000 }, t);
    t.last().open();
    setHidden(true);
    vi.advanceTimersByTime(59_000);
    expect(ch.status()).toBe('open');
    vi.advanceTimersByTime(1_000);
    expect(ch.status()).toBe('paused');
    expect(t.last().closed).toBe(true);
    setHidden(false);
    expect(ch.status()).toBe('connecting');
    expect(t.sources).toHaveLength(2);
    expect(onResume).toHaveBeenCalledTimes(1);
    ch.close();
  });

  it('a short hide does not pause', () => {
    vi.useFakeTimers();
    const t = createFakeTransport();
    const ch = createLiveChannel('/s', { events: [], onEvent: () => {} }, t);
    t.last().open();
    setHidden(true);
    vi.advanceTimersByTime(10_000);
    setHidden(false);
    vi.advanceTimersByTime(120_000);
    expect(ch.status()).toBe('open');
    ch.close();
  });
});

describe('server clock', () => {
  afterEach(() => serverClock.reset());

  it('derives the offset from /api/me.serverTime', () => {
    expect(computeOffset('2026-11-24T10:00:05.000Z', Date.parse('2026-11-24T10:00:00.000Z'))).toBe(5000);
    expect(computeOffset('garbage', 1)).toBe(0);
    serverClock.sync('2026-11-24T10:00:00.000Z', Date.parse('2026-11-24T10:00:30.000Z'));
    expect(serverClock.offset()).toBe(-30_000);
    expect(serverClock.now(Date.parse('2026-11-24T10:01:00.000Z'))).toBe(Date.parse('2026-11-24T10:00:30.000Z'));
  });
});
