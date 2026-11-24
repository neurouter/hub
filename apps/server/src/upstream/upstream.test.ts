import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeUpstream } from '../../test-utils/fake-upstream.js';
import { FakeClock } from '../test/fakes/context.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { classifyUpstreamError, UpstreamError } from './errors.js';
import { UpstreamPool, type UpstreamServer } from './pool.js';
import type { CredentialResolver } from './credentials.js';

const logger = { debug() {}, warn() {} };

describe('circuit breaker', () => {
  it('opens after 5 failures, half-opens with one probe, closes on success', () => {
    const clock = new FakeClock();
    const b = new CircuitBreaker(clock, 5, 30_000);
    for (let i = 0; i < 4; i++) expect(b.onFailure()).toBe(false);
    expect(b.onFailure()).toBe(true);
    expect(b.state).toBe('open');
    expect(b.tryAcquire()).toBe(false);
    clock.advance(30_000);
    expect(b.state).toBe('half_open');
    expect(b.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(false); // single probe
    expect(b.onFailure()).toBe(true); // probe failed → open again
    expect(b.state).toBe('open');
    clock.advance(30_000);
    expect(b.tryAcquire()).toBe(true);
    b.onSuccess();
    expect(b.state).toBe('closed');
  });
});

describe('error classification', () => {
  it('maps timeouts, 401s and transport errors', () => {
    expect(classifyUpstreamError({ code: 'REQUEST_TIMEOUT', message: 'x' }).kind).toBe('timeout');
    expect(classifyUpstreamError({ name: 'UnauthorizedError', message: 'x' }).kind).toBe('auth_required');
    expect(classifyUpstreamError(new Error('Error POSTing to endpoint (HTTP 401)')).kind).toBe('auth_required');
    expect(classifyUpstreamError(new Error('ECONNREFUSED')).kind).toBe('transport');
    const ac = new AbortController();
    ac.abort();
    expect(classifyUpstreamError(new Error('aborted'), ac.signal).kind).toBe('cancelled');
  });
});

describe('upstream pool', () => {
  let up: FakeUpstream;
  let headers: Record<string, string>;
  let eras: string[];
  let pool: UpstreamPool;
  const clock = new FakeClock();
  const server = (over: Partial<UpstreamServer> = {}): UpstreamServer => ({ id: 's1', name: 'GitHub', url: up.url, transport: up.variant === 'sse' ? 'sse' : 'streamable_http', authMode: 'shared', timeoutMs: 5000, ...over });
  const make = (variant: 'modern' | 'legacy' | 'sse' = 'modern') => {
    up = new FakeUpstream({ variant, requireAuth: { header: 'authorization', value: 'Bearer up-secret' } });
    headers = { authorization: 'Bearer up-secret' };
    eras = [];
    const credentials = { headersFor: async () => headers, invalidate() {} } as unknown as CredentialResolver;
    pool = new UpstreamPool({ clock, credentials, fetchFor: () => up.fetch, logger, onEra: (_id, e) => eras.push(e.era) });
  };
  afterEach(async () => {
    await pool.close();
    await up.close();
  });

  describe.each(['modern', 'legacy', 'sse'] as const)('%s upstream', (variant) => {
    beforeEach(() => make(variant));
    it('lists and calls with the injected credential and reuses the pooled client', async () => {
      const { tools, era } = await pool.listTools(server(), null);
      expect(tools.map((t) => t.name)).toEqual(['echo']);
      expect(era.era).toBe(variant === 'sse' ? 'legacy_sse' : variant);
      const r = await pool.callTool(server(), null, { name: 'echo', arguments: { text: 'a' } }, { timeoutMs: 5000 });
      expect(r).toMatchObject({ content: [{ type: 'text', text: '{"text":"a"}' }] });
      expect(pool.size).toBe(1);
      expect(up.calls[0]!.headers.get('authorization')).toBe('Bearer up-secret');
    });
  });

  it('never forwards the inbound client token upstream (only the server credential)', async () => {
    make();
    const inbound = 'nr_live_ABCDEFGHJK_inboundsecretinboundsecretinboundsecret1';
    await pool.callTool(server(), null, { name: 'echo', arguments: {}, _meta: { 'dev.neurouter/session-id': 's' } }, { timeoutMs: 5000 });
    for (const r of up.requests) {
      expect(JSON.stringify(r)).not.toContain(inbound);
      expect(r.headers.authorization).toBe('Bearer up-secret');
    }
  });

  it('times out slow calls with an UpstreamError(timeout)', async () => {
    make();
    up.delayMs = 500;
    await expect(pool.callTool(server(), null, { name: 'echo', arguments: {} }, { timeoutMs: 50 })).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('client abort cancels the call', async () => {
    make();
    up.delayMs = 500;
    const ac = new AbortController();
    const p = pool.callTool(server(), null, { name: 'echo', arguments: {} }, { timeoutMs: 5000, signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toMatchObject({ kind: 'cancelled' });
  });

  it('opens the circuit after repeated transport failures', async () => {
    make();
    up.failNext = 100;
    for (let i = 0; i < 5; i++) await expect(pool.listTools(server(), null)).rejects.toBeInstanceOf(UpstreamError);
    await expect(pool.callTool(server(), null, { name: 'echo', arguments: {} }, { timeoutMs: 1000 })).rejects.toMatchObject({ kind: 'circuit_open', message: 'Server GitHub is unavailable' });
  });

  it('caches the era verdict: a second connection skips the server/discover probe', async () => {
    make();
    await pool.listTools(server(), null);
    pool.invalidate('nope');
    // a second identity (different server id sharing the url) still probes; same server reconnect does not
    const probes = () => up.requestsFor('server/discover').length;
    expect(probes()).toBe(1);
    await pool.close();
    await pool.listTools(server(), null);
    expect(probes()).toBe(1);
    expect(eras).toEqual(['modern', 'modern']);
  });

  it('per-user OAuth servers need a user identity', async () => {
    make();
    await expect(pool.listTools(server({ authMode: 'user_oauth' }), null)).rejects.toMatchObject({ kind: 'connect_required' });
  });

  it('401 from the upstream is auth_required (does not trip the breaker)', async () => {
    make();
    headers = { authorization: 'Bearer wrong' };
    for (let i = 0; i < 6; i++) await expect(pool.listTools(server(), null)).rejects.toMatchObject({ kind: 'auth_required' });
    expect(pool.breaker('s1').state).toBe('closed');
  });
});
