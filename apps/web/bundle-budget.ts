/**
 * Initial-load bundle budget (frontend W11): the entry script, every `modulepreload` and the
 * stylesheets referenced by dist/index.html, measured gzipped. Lazy route chunks (charts, audit,
 * settings…) are not part of the initial load and are not counted.
 *
 * Run after a build: `npm run size -w @neurouter/web` (Node ≥ 24 runs this TypeScript directly).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

export interface Budget {
  /** gzip KiB for the entry script + modulepreloads */
  initialJsKb: number;
  /** gzip KiB for the initial stylesheets */
  initialCssKb: number;
}

export const BUDGET: Budget = { initialJsKb: 250, initialCssKb: 40 };

/** Asset URLs the browser fetches before first render, from the built index.html. */
export function initialAssets(html: string): { js: string[]; css: string[] } {
  const js = new Set<string>();
  const css = new Set<string>();
  for (const m of html.matchAll(/<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/g)) js.add(m[1]!);
  for (const m of html.matchAll(/<link\b[^>]*\brel="modulepreload"[^>]*\bhref="([^"]+)"/g)) js.add(m[1]!);
  for (const m of html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/g)) if (m[1]!.startsWith('/assets/')) css.add(m[1]!);
  return { js: [...js], css: [...css] };
}

export interface SizeReport {
  jsKb: number;
  cssKb: number;
  files: { path: string; gzipKb: number }[];
  over: string[];
}

export function checkBudget(sizes: { js: Record<string, number>; css: Record<string, number> }, budget: Budget = BUDGET): SizeReport {
  const kb = (n: number) => Math.round((n / 1024) * 10) / 10;
  const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
  const jsKb = kb(sum(sizes.js));
  const cssKb = kb(sum(sizes.css));
  const over: string[] = [];
  if (jsKb > budget.initialJsKb) over.push(`initial JS ${jsKb} KiB gzip > budget ${budget.initialJsKb} KiB`);
  if (cssKb > budget.initialCssKb) over.push(`initial CSS ${cssKb} KiB gzip > budget ${budget.initialCssKb} KiB`);
  const files = [...Object.entries(sizes.js), ...Object.entries(sizes.css)].map(([path, n]) => ({ path, gzipKb: kb(n) })).sort((a, b) => b.gzipKb - a.gzipKb);
  return { jsKb, cssKb, files, over };
}

export function measure(distDir: string): SizeReport {
  const html = readFileSync(join(distDir, 'index.html'), 'utf8');
  const { js, css } = initialAssets(html);
  const gz = (p: string) => gzipSync(readFileSync(join(distDir, p.replace(/^\//, ''))), { level: 9 }).length;
  return checkBudget({ js: Object.fromEntries(js.map((p) => [p, gz(p)])), css: Object.fromEntries(css.map((p) => [p, gz(p)])) });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = measure(join(import.meta.dirname, 'dist'));
  console.log(`initial JS  ${report.jsKb} KiB gzip (budget ${BUDGET.initialJsKb})`);
  console.log(`initial CSS ${report.cssKb} KiB gzip (budget ${BUDGET.initialCssKb})`);
  for (const f of report.files.slice(0, 5)) console.log(`  ${f.gzipKb.toFixed(1).padStart(6)} KiB  ${f.path}`);
  if (report.over.length) {
    console.error(`Bundle budget exceeded:\n- ${report.over.join('\n- ')}`);
    process.exit(1);
  }
}
