import { describe, expect, it } from 'vitest';
import { isValidSlug, slugify } from './slug';
import { syncSummary } from './use-sync';

describe('server slug', () => {
  it('derives a valid slug from the name', () => {
    expect(slugify('Internal Docs (v2)')).toBe('internal-docs-v2');
    expect(slugify('  GitHub  ')).toBe('github');
    expect(slugify('Café__Ops')).toBe('cafe-ops');
    expect(slugify('x'.repeat(40))).toHaveLength(32);
    expect(isValidSlug(slugify('Postgres Analytics'))).toBe(true);
    expect(isValidSlug('bad_slug')).toBe(false);
    expect(isValidSlug('-x')).toBe(false);
  });

  it('summarises a sync job result', () => {
    expect(syncSummary({ added: 2, changed: 1, removed: 0, unchanged: 21 })).toBe('2 new, 1 changed (needs review), 0 removed');
    expect(syncSummary({ added: 0, changed: 0, removed: 1, unchanged: 3 })).toBe('0 new, 0 changed, 1 removed');
    expect(syncSummary('nope')).toBeNull();
  });
});
