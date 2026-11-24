import ipaddr from 'ipaddr.js';

/**
 * Outbound network policy (backend §7.6). IPs are classified with ipaddr.js (never hand-parsed);
 * IPv4-mapped IPv6 is un-mapped first.
 */
export interface NetPolicy {
  /** Allow RFC1918, loopback, link-local, ULA, CGNAT (upstreams are usually internal). */
  allowPrivate: boolean;
  /** Always denied (cloud metadata etc.), checked even when private networks are allowed. */
  denyCidrs: readonly string[];
  /** `https` only, except plain http to loopback (dev) or anywhere (internal upstreams). */
  allowHttp: 'never' | 'loopback' | 'always';
}

export class SsrfError extends Error {
  constructor(
    message: string,
    readonly reason: 'scheme' | 'blocked_address' | 'denied_cidr' | 'invalid_url' | 'dns' | 'redirect' | 'too_large' | 'credentials',
  ) {
    super(message);
    this.name = 'SsrfError';
  }
}

/** Ranges that are never reachable, whatever the policy. */
const ALWAYS_BLOCKED = new Set(['unspecified', 'broadcast', 'multicast', 'reserved']);
/** Ranges that count as "private" (blocked unless allowPrivate). Global unicast is the only public range. */
const PUBLIC = new Set(['unicast']);

export function parseCidrs(cidrs: readonly string[]): [ipaddr.IPv4 | ipaddr.IPv6, number][] {
  return cidrs.map((c) => {
    if (!ipaddr.isValidCIDR(c)) throw new Error(`Invalid CIDR "${c}"`);
    return ipaddr.parseCIDR(c);
  });
}

export function rangeOf(ip: string): string {
  return ipaddr.process(ip).range();
}

export function isLoopback(ip: string): boolean {
  return ipaddr.isValid(ip) && rangeOf(ip) === 'loopback';
}

/** Returns why `ip` is blocked under `policy`, or null when it may be contacted. */
export function blockedReason(ip: string, policy: NetPolicy, denied = parseCidrs(policy.denyCidrs)): string | null {
  if (!ipaddr.isValid(ip)) return 'invalid address';
  const addr = ipaddr.process(ip);
  for (const [net, bits] of denied) {
    if (addr.kind() === net.kind() && addr.match(net, bits)) return `address ${addr.toString()} is in a denied range`;
  }
  const range = addr.range();
  if (ALWAYS_BLOCKED.has(range)) return `address ${addr.toString()} is ${range}`;
  if (!PUBLIC.has(range) && !policy.allowPrivate) return `address ${addr.toString()} is ${range}`;
  return null;
}

/** Strips IPv6 brackets from a URL hostname. */
export function hostOf(url: URL): string {
  return url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
}

/**
 * Validates scheme, credentials and (for IP literals) the address. Hostnames are checked again
 * at connect time through the pinned DNS lookup.
 */
export function assertUrlAllowed(raw: string | URL, policy: NetPolicy): URL {
  let url: URL;
  try {
    url = typeof raw === 'string' ? new URL(raw) : raw;
  } catch {
    throw new SsrfError('Invalid URL', 'invalid_url');
  }
  if (url.username || url.password) throw new SsrfError('URLs with credentials are not allowed', 'credentials');
  const host = hostOf(url);
  const literal = ipaddr.isValid(host);
  if (url.protocol === 'http:') {
    const loop = (literal && isLoopback(host)) || host === 'localhost' || host.endsWith('.localhost');
    if (policy.allowHttp === 'never' || (policy.allowHttp === 'loopback' && !loop)) throw new SsrfError('Only https URLs are allowed', 'scheme');
  } else if (url.protocol !== 'https:') {
    throw new SsrfError(`Scheme ${url.protocol} is not allowed`, 'scheme');
  }
  if (literal) {
    const reason = blockedReason(host, policy);
    if (reason) throw new SsrfError(`Blocked: ${reason}`, 'blocked_address');
  }
  return url;
}
