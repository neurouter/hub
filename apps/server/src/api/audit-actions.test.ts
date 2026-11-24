import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { api } from '@neurouter/shared';
import { ROUTE_AUDIT } from './audit-actions.js';

const SRC = fileURLToPath(new URL('..', import.meta.url));

function sourceText(dir: string): string {
  let out = '';
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== 'test') out += sourceText(p);
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'audit-actions.ts') out += readFileSync(p, 'utf8');
  }
  return out;
}

const mutating = Object.entries(api as unknown as Record<string, Record<string, { method: string }>>).flatMap(([area, eps]) =>
  Object.entries(eps)
    .filter(([, e]) => e.method !== 'GET')
    .map(([name]) => `${area}.${name}`),
);

describe('route audit registry', () => {
  it('every mutating contract endpoint declares its audit action (or why it is exempt)', () => {
    expect(mutating.filter((k) => !(k in ROUTE_AUDIT))).toEqual([]);
  });

  it('has no entries for endpoints that are gone or are GETs', () => {
    expect(Object.keys(ROUTE_AUDIT).filter((k) => !mutating.includes(k))).toEqual([]);
  });

  it('every declared action is actually recorded somewhere in the server', () => {
    const src = sourceText(SRC);
    const missing = Object.values(ROUTE_AUDIT)
      .flatMap((r) => ('actions' in r ? r.actions : []))
      .filter((action) => !src.includes(`'${action}'`));
    expect(missing).toEqual([]);
  });

  it('exemptions carry a reason', () => {
    for (const r of Object.values(ROUTE_AUDIT)) if ('exempt' in r) expect(r.exempt.length).toBeGreaterThan(10);
  });
});
