import { describe, expect, it } from 'vitest';
import { PROXIED_PREFIXES, buildDevProxy, parseDevPort } from './dev-proxy.ts';

describe('dev proxy from NEUROUTER_DEV_API_URL', () => {
  it('fails with a readable message when unset or invalid', () => {
    expect(() => buildDevProxy(undefined)).toThrow(/NEUROUTER_DEV_API_URL is not set/);
    expect(() => buildDevProxy('  ')).toThrow(/is not set/);
    expect(() => buildDevProxy('not a url')).toThrow(/absolute http/);
    expect(() => buildDevProxy('ftp://x')).toThrow(/http or https/);
  });

  it('proxies every backend prefix to the configured origin, keeping Host', () => {
    const proxy = buildDevProxy('http://backend.internal:4000/ignored/path');
    expect(Object.keys(proxy)).toEqual([...PROXIED_PREFIXES]);
    for (const p of PROXIED_PREFIXES) expect(proxy[p]).toMatchObject({ target: 'http://backend.internal:4000', changeOrigin: false, xfwd: true });
  });

  it('parses the optional dev port', () => {
    expect(parseDevPort(undefined)).toBeUndefined();
    expect(parseDevPort('5173')).toBe(5173);
    expect(() => parseDevPort('abc')).toThrow();
  });
});
