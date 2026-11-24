import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';

const root = resolve(import.meta.dirname, '..');
const INIT_SCRIPT = readFileSync(resolve(root, 'public/theme-init.js'), 'utf8');
const INDEX_HTML = readFileSync(resolve(root, 'index.html'), 'utf8');

/**
 * W11 CSP checks (script-src 'self', no 'unsafe-eval', no inline scripts). Zod's JIT probe would
 * otherwise raise a CSP violation report on every page load.
 */
describe('CSP compatibility', () => {
  it('the classic boot script turns zod JIT off through the global zod reads at load', () => {
    new Function(INIT_SCRIPT)();
    expect((globalThis as { __zod_globalConfig?: { jitless?: boolean } }).__zod_globalConfig?.jitless).toBe(true);
    // same object zod uses
    expect(z.config().jitless).toBe(true);
  });

  it('index.html loads the boot script before the module entry and has no inline script', () => {
    const boot = INDEX_HTML.indexOf('<script src="/theme-init.js"></script>');
    const entry = INDEX_HTML.indexOf('<script type="module"');
    expect(boot).toBeGreaterThan(-1);
    expect(entry).toBeGreaterThan(boot);
    for (const m of INDEX_HTML.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      expect(m[1]).toMatch(/\bsrc=/);
      expect(m[2]!.trim()).toBe('');
    }
  });
});
