import { describe, expect, it } from 'vitest';
import { checkBudget, initialAssets } from './bundle-budget.ts';

const HTML = `<!doctype html><html><head>
<script src="/theme-init.js"></script>
<script type="module" crossorigin src="/assets/index-A.js"></script>
<link rel="modulepreload" crossorigin href="/assets/jsx-runtime-B.js">
<link rel="modulepreload" crossorigin href="/assets/utils-C.js">
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<link rel="stylesheet" crossorigin href="/assets/index-D.css">
</head><body></body></html>`;

describe('bundle budget', () => {
  it('collects the entry, modulepreloads and stylesheets (not classic scripts or icons)', () => {
    expect(initialAssets(HTML)).toEqual({ js: ['/assets/index-A.js', '/assets/jsx-runtime-B.js', '/assets/utils-C.js'], css: ['/assets/index-D.css'] });
  });

  it('sums gzip sizes and reports what is over budget', () => {
    const ok = checkBudget({ js: { a: 100 * 1024, b: 50 * 1024 }, css: { c: 10 * 1024 } }, { initialJsKb: 200, initialCssKb: 20 });
    expect(ok).toMatchObject({ jsKb: 150, cssKb: 10, over: [] });
    expect(ok.files[0]).toEqual({ path: 'a', gzipKb: 100 });
    const bad = checkBudget({ js: { a: 300 * 1024 }, css: { c: 30 * 1024 } }, { initialJsKb: 200, initialCssKb: 20 });
    expect(bad.over).toEqual(['initial JS 300 KiB gzip > budget 200 KiB', 'initial CSS 30 KiB gzip > budget 20 KiB']);
  });
});
