import { describe, expect, it } from 'vitest';
import { faviconLinks, pngFromIco } from './library-icons.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cf000000ff00fb03fd2c2c0b0000000049454e44ae426082', 'hex');

function ico(frames: Array<{ width: number; data: Buffer }>): Buffer {
  const head = Buffer.alloc(6 + 16 * frames.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(frames.length, 4);
  let off = head.length;
  frames.forEach((f, i) => {
    const e = 6 + i * 16;
    head[e] = f.width;
    head.writeUInt32LE(f.data.length, e + 8);
    head.writeUInt32LE(off, e + 12);
    off += f.data.length;
  });
  return Buffer.concat([head, ...frames.map((f) => f.data)]);
}

describe('library icons', () => {
  it('extracts the largest PNG frame from an .ico and skips BMP frames', () => {
    const big = Buffer.concat([PNG, Buffer.from('big')]);
    expect(pngFromIco(ico([{ width: 16, data: PNG }, { width: 32, data: Buffer.alloc(40, 1) }, { width: 0, data: big }]))!.equals(big)).toBe(true);
    expect(pngFromIco(ico([{ width: 16, data: Buffer.alloc(40, 1) }]))).toBeNull();
    expect(pngFromIco(PNG)).toBeNull();
  });

  it('finds favicon links, touch icon first, resolved against the page, https only', () => {
    const html = `<head><link rel="stylesheet" href="/a.css"><link rel="icon" href="/favicon.ico"><link rel='icon' type='image/svg+xml' href='/logo.svg'>
      <link href="https://cdn.example.com/touch.png" rel="apple-touch-icon" sizes="180x180"><link rel="icon" href="http://insecure.example/x.png"></head>`;
    expect(faviconLinks(html, 'https://example.com/docs/')).toEqual(['https://cdn.example.com/touch.png', 'https://example.com/logo.svg', 'https://example.com/favicon.ico']);
  });
});
