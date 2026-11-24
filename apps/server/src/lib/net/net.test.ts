import { describe, expect, it } from 'vitest';
import { assertUrlAllowed, blockedReason, SsrfError, type NetPolicy } from './ssrf-guard.js';
import { createSafeFetch, pinnedLookup } from './safe-fetch.js';

const strict: NetPolicy = { allowPrivate: false, denyCidrs: ['169.254.0.0/16', 'fd00:ec2::/32'], allowHttp: 'never' };
const upstream: NetPolicy = { allowPrivate: true, denyCidrs: ['169.254.0.0/16', 'fd00:ec2::/32'], allowHttp: 'always' };

describe('ssrf guard', () => {
  it.each([
    ['10.0.0.1'], ['192.168.1.1'], ['172.16.0.5'], ['127.0.0.1'], ['::1'], ['fc00::1'], ['fe80::1'], ['100.64.0.1'], ['0.0.0.0'], ['::ffff:127.0.0.1'], ['::ffff:10.0.0.1'], ['169.254.169.254'], ['224.0.0.1'],
  ])('strict blocks %s', (ip) => {
    expect(blockedReason(ip, strict)).not.toBeNull();
  });
  it.each([['8.8.8.8'], ['2606:4700::1111']])('strict allows public %s', (ip) => expect(blockedReason(ip, strict)).toBeNull());
  it('upstream policy allows private networks but never cloud metadata', () => {
    expect(blockedReason('10.0.0.1', upstream)).toBeNull();
    expect(blockedReason('127.0.0.1', upstream)).toBeNull();
    expect(blockedReason('169.254.169.254', upstream)).toMatch(/denied/);
    expect(blockedReason('::ffff:169.254.169.254', upstream)).toMatch(/denied/);
    expect(blockedReason('fd00:ec2::254', upstream)).toMatch(/denied/);
    expect(blockedReason('0.0.0.0', upstream)).not.toBeNull();
  });
  it.each([
    'https://0x7f.0.0.1/', 'https://2130706433/', 'https://0177.0.0.1/', 'https://127.1/', 'https://[::ffff:7f00:1]/', 'https://[::1]/x',
  ])('normalizes obfuscated literals: %s', (u) => {
    expect(() => assertUrlAllowed(u, strict)).toThrow(SsrfError);
  });
  it('scheme and credential rules', () => {
    expect(() => assertUrlAllowed('http://example.com', strict)).toThrow(/https/);
    expect(() => assertUrlAllowed('ftp://example.com', upstream)).toThrow(/Scheme/);
    expect(() => assertUrlAllowed('https://u:p@example.com', upstream)).toThrow(/credentials/);
    expect(assertUrlAllowed('http://localhost:3000/x', { ...strict, allowHttp: 'loopback' }).host).toBe('localhost:3000');
    expect(() => assertUrlAllowed('http://example.com', { ...strict, allowHttp: 'loopback' })).toThrow();
  });
});

describe('pinned DNS lookup', () => {
  const run = (records: { address: string; family: number }[], policy = strict, all = false) =>
    new Promise<{ err: Error | null; addr: unknown }>((resolve) => {
      pinnedLookup(policy, async () => records)('h.test', all ? { all: true } : {}, (err, addr) => resolve({ err, addr }));
    });
  it('rejects when ANY record is blocked (mixed records)', async () => {
    const r = await run([{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }]);
    expect(r.err).toBeInstanceOf(SsrfError);
  });
  it('pins the first allowed address', async () => {
    expect((await run([{ address: '93.184.216.34', family: 4 }, { address: '93.184.216.35', family: 4 }])).addr).toBe('93.184.216.34');
    expect((await run([{ address: '2606:4700::1111', family: 6 }], strict, true)).addr).toEqual([{ address: '2606:4700::1111', family: 6 }]);
  });
  it('no records → ENOTFOUND', async () => {
    expect((await run([])).err?.message).toMatch(/No addresses/);
  });
});

describe('safe fetch', () => {
  const redirecting = (hops: Record<string, Response>) => async (url: URL) => hops[url.href] ?? new Response('nf', { status: 404 });
  it('follows redirects with re-validation of every hop', async () => {
    const f = createSafeFetch({
      policy: strict,
      transport: redirecting({
        'https://a.test/': new Response(null, { status: 302, headers: { location: 'https://b.test/x' } }),
        'https://b.test/x': new Response('ok'),
      }),
    });
    expect(await (await f('https://a.test/')).text()).toBe('ok');
    const bad = createSafeFetch({ policy: strict, transport: redirecting({ 'https://a.test/': new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } }) }) });
    await expect(bad('https://a.test/')).rejects.toThrow(SsrfError);
  });
  it('caps hops and can treat redirects as errors', async () => {
    const loop = createSafeFetch({ policy: strict, maxRedirects: 2, transport: async () => new Response(null, { status: 302, headers: { location: 'https://a.test/' } }) });
    await expect(loop('https://a.test/')).rejects.toThrow(/Too many redirects/);
    const noRedir = createSafeFetch({ policy: strict, redirectsAreErrors: true, transport: async () => new Response(null, { status: 301, headers: { location: 'https://a.test/b' } }) });
    await expect(noRedir('https://a.test/')).rejects.toThrow(/Redirects are not allowed/);
  });
  it('strips credentials on cross-origin redirects', async () => {
    const seen: (string | null)[] = [];
    const f = createSafeFetch({
      policy: strict,
      transport: async (url, init) => {
        seen.push(new Headers(init.headers).get('authorization'));
        return url.host === 'a.test' ? new Response(null, { status: 307, headers: { location: 'https://b.test/' } }) : new Response('ok');
      },
    });
    await f('https://a.test/', { headers: { authorization: 'Bearer x' } });
    expect(seen).toEqual(['Bearer x', null]);
  });
  it('caps body size (declared and streamed)', async () => {
    const declared = createSafeFetch({ policy: strict, maxBytes: 4, transport: async () => new Response('123456', { headers: { 'content-length': '6' } }) });
    await expect(declared('https://a.test/')).rejects.toThrow(/exceeds/);
    const streamed = createSafeFetch({
      policy: strict,
      maxBytes: 4,
      transport: async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('123')); c.enqueue(new TextEncoder().encode('456')); c.close(); } })),
    });
    await expect((await streamed('https://a.test/')).text()).rejects.toThrow(/exceeds/);
  });
  it('enforces the overall timeout', async () => {
    const f = createSafeFetch({
      policy: strict,
      timeoutMs: 20,
      transport: (_u, init) => new Promise((_r, rej) => init.signal?.addEventListener('abort', () => rej(init.signal!.reason))),
    });
    await expect(f('https://a.test/')).rejects.toThrow();
  });
  it('blocks private literals before connecting', async () => {
    const f = createSafeFetch({ policy: strict, transport: async () => new Response('should not happen') });
    await expect(f('https://10.0.0.1/')).rejects.toThrow(SsrfError);
  });
});

describe('safe fetch over a real socket (undici Agent + pinned lookup)', () => {
  it('connects to a loopback server when allowed and refuses it when not', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((_req, res) => res.end('hello'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const resolver = async () => [{ address: '127.0.0.1', family: 4 }];
    try {
      const ok = createSafeFetch({ policy: upstream, resolver });
      expect(await (await ok(`http://localhost:${port}/`)).text()).toBe('hello');
      await ok.close();
      const refused = createSafeFetch({ policy: { ...strict, allowHttp: 'loopback' }, resolver });
      await expect(refused(`http://localhost:${port}/`)).rejects.toThrow();
      await refused.close();
    } finally {
      server.close();
    }
  });
});
