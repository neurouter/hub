import { describe, expect, it } from 'vitest';
import { healthStatus } from './health.js';
import { pickServerInfoIcon, sniffImage, unsafeSvgReason, validateIcon } from './icons.js';

describe('icon validation', () => {
  it('detects types from magic bytes, not headers', () => {
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]))).toBe('image/webp');
    expect(sniffImage(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('image/svg+xml');
    expect(sniffImage(Buffer.from('<html><svg></svg></html>'))).toBeNull();
    expect(sniffImage(Buffer.from('GIF89a'))).toBeNull();
  });
  it.each([
    ['<svg><script>alert(1)</script></svg>', /script/],
    ['<svg onload="x()"></svg>', /event handler/],
    ['<svg><foreignObject/></svg>', /foreignObject/],
    ['<svg><image href="https://evil.test/x.png"/></svg>', /external/],
    ['<svg><use xlink:href="javascript:alert(1)"/></svg>', /external/],
    ['<svg><use href="#a"/></svg>', null],
  ])('SVG screen %s', (svg, reason) => {
    const r = unsafeSvgReason(svg);
    if (reason === null) expect(r).toBeNull();
    else expect(r).toMatch(reason);
  });
  it('enforces the size cap', () => {
    expect(validateIcon(Buffer.alloc(300 * 1024))).toEqual({ ok: false, error: 'Icon larger than 256 KB' });
    expect(validateIcon(Buffer.alloc(0))).toMatchObject({ ok: false });
  });
  it('picks a PNG near 64 px from https/data sources only', () => {
    expect(pickServerInfoIcon([{ src: 'http://x/a.png', mimeType: 'image/png' }, { src: 'https://x/b.svg', mimeType: 'image/svg+xml' }, { src: 'https://x/c.png', mimeType: 'image/png', sizes: ['256x256'] }, { src: 'https://x/d.png', mimeType: 'image/png', sizes: ['64x64'] }])).toBe('https://x/d.png');
    expect(pickServerInfoIcon(null)).toBeNull();
  });
});

describe('health status rules', () => {
  it.each([
    [{ ok: true, latencyMs: 100, consecutiveFailures: 0, circuitOpen: false }, 'up'],
    [{ ok: true, latencyMs: 2500, consecutiveFailures: 0, circuitOpen: false }, 'degraded'],
    [{ ok: false, latencyMs: 0, consecutiveFailures: 1, circuitOpen: false }, 'degraded'],
    [{ ok: false, latencyMs: 0, consecutiveFailures: 3, circuitOpen: false }, 'down'],
    [{ ok: true, latencyMs: 10, consecutiveFailures: 0, circuitOpen: true }, 'down'],
  ])('%o → %s', (input, expected) => expect(healthStatus(input)).toBe(expected));
});
