import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';
import { assertUrlAllowed, blockedReason, parseCidrs, SsrfError, type NetPolicy } from './ssrf-guard.js';

export type Resolver = (hostname: string) => Promise<LookupAddress[]>;
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface SafeFetchOptions {
  policy: NetPolicy;
  /** Response body cap in bytes (default 16 MiB). */
  maxBytes?: number;
  /** Overall deadline per request; 0 = none (long-lived streams). */
  timeoutMs?: number;
  connectTimeoutMs?: number;
  /** Redirects are followed manually with every hop re-validated; 0 = a 3xx is returned as-is. */
  maxRedirects?: number;
  /** Treat any 3xx as an error (CIMD: the AS must not follow redirects). */
  redirectsAreErrors?: boolean;
  resolver?: Resolver;
  /** Transport override (tests); receives the validated URL and init. */
  transport?: (url: URL, init: RequestInit & { dispatcher?: unknown }) => Promise<Response>;
}

const defaultResolver: Resolver = (host) => dnsLookup(host, { all: true, verbatim: true });

/**
 * DNS lookup for undici's connector: resolves every A/AAAA record, rejects the connection when
 * ANY record is blocked, and pins the first allowed address (no TOCTOU / DNS rebinding).
 */
export function pinnedLookup(policy: NetPolicy, resolver: Resolver = defaultResolver) {
  const denied = parseCidrs(policy.denyCidrs);
  return (hostname: string, options: { all?: boolean } | number | undefined, callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => {
    resolver(hostname).then(
      (records) => {
        if (records.length === 0) return callback(Object.assign(new Error(`No addresses for ${hostname}`), { code: 'ENOTFOUND' }), '', 0);
        for (const r of records) {
          const reason = blockedReason(r.address, policy, denied);
          if (reason) return callback(Object.assign(new SsrfError(`Blocked: ${hostname} resolves to a forbidden address (${reason})`, 'blocked_address'), { code: 'EBLOCKED' }), '', 0);
        }
        const first = records[0]!;
        if (typeof options === 'object' && options?.all) callback(null, [first]);
        else callback(null, first.address, first.family);
      },
      (err: NodeJS.ErrnoException) => callback(err, '', 0),
    );
  };
}

function capBody(res: Response, maxBytes: number): Response {
  const len = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(len) && len > maxBytes) {
    void res.body?.cancel();
    throw new SsrfError(`Response exceeds ${maxBytes} bytes`, 'too_large');
  }
  if (!res.body) return res;
  let seen = 0;
  const limited = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) controller.error(new SsrfError(`Response exceeds ${maxBytes} bytes`, 'too_large'));
        else controller.enqueue(chunk);
      },
    }),
  );
  return new Response(limited, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/**
 * fetch with the SSRF guard (backend §7.6): scheme/IP policy, pinned DNS, manual redirect
 * validation, size and time caps. Returns WHATWG Response objects.
 */
export function createSafeFetch(opts: SafeFetchOptions): FetchLike & { close(): Promise<void> } {
  const maxBytes = opts.maxBytes ?? 16 * 1024 * 1024;
  const maxRedirects = opts.maxRedirects ?? 3;
  const agent = opts.transport
    ? null
    : new Agent({ connect: { lookup: pinnedLookup(opts.policy, opts.resolver) as never, timeout: opts.connectTimeoutMs ?? 5000 } });
  const send =
    opts.transport ??
    ((url: URL, init: RequestInit) => undiciFetch(url, { ...(init as UndiciRequestInit), dispatcher: agent! }) as unknown as Promise<Response>);

  const fn = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    let url: URL;
    let reqInit: RequestInit = init;
    if (input instanceof Request) {
      url = new URL(input.url);
      reqInit = { method: input.method, headers: input.headers, body: input.body ? await input.arrayBuffer() : null, signal: input.signal, ...init };
    } else {
      url = new URL(String(input));
    }
    const signals = [reqInit.signal, opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined].filter((s): s is AbortSignal => !!s);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    let method = (reqInit.method ?? 'GET').toUpperCase();
    let body = reqInit.body;
    for (let hop = 0; ; hop++) {
      assertUrlAllowed(url, opts.policy);
      const res = await send(url, { ...reqInit, method, body, redirect: 'manual', ...(signal ? { signal } : {}) });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!location) return capBody(res, maxBytes);
      if (opts.redirectsAreErrors) {
        void res.body?.cancel();
        throw new SsrfError('Redirects are not allowed for this request', 'redirect');
      }
      if (maxRedirects === 0) return res;
      void res.body?.cancel();
      if (hop >= maxRedirects) throw new SsrfError(`Too many redirects (max ${maxRedirects})`, 'redirect');
      const next = new URL(location, url);
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = null;
      }
      // never forward credentials to another origin
      if (next.origin !== url.origin && reqInit.headers) {
        const h = new Headers(reqInit.headers);
        h.delete('authorization');
        h.delete('cookie');
        reqInit = { ...reqInit, headers: h };
      }
      url = next;
    }
  };
  return Object.assign(fn, { close: async () => { await agent?.close(); } });
}
