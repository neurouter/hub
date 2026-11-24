import { describe, expect, it } from 'vitest';
import { lineDiff, wordDiff } from './diff';

describe('lineDiff', () => {
  it('aligns a replaced line side by side and counts changes', () => {
    const d = lineDiff('a\nb\nc\n', 'a\nB\nc\nd\n');
    expect(d.added).toBe(2);
    expect(d.removed).toBe(1);
    expect(d.split[1]).toEqual({ left: { n: 2, text: 'b', kind: 'del' }, right: { n: 2, text: 'B', kind: 'add' } });
    expect(d.split[3]).toEqual({ left: null, right: { n: 4, text: 'd', kind: 'add' } });
    expect(d.unified.map((r) => r.kind)).toEqual(['ctx', 'del', 'add', 'ctx', 'add']);
  });

  it('reports no changes for equal text', () => {
    const d = lineDiff('x\n', 'x\n');
    expect(d.added + d.removed).toBe(0);
    expect(d.split).toHaveLength(1);
  });
});

describe('wordDiff', () => {
  it('marks added and removed words', () => {
    const parts = wordDiff('Returns titles, snippets and URLs.', 'Returns titles, full page content and URLs.');
    expect(parts.filter((p) => p.kind === 'del').map((p) => p.text.trim())).toContain('snippets');
    expect(parts.filter((p) => p.kind === 'add').map((p) => p.text).join('')).toContain('full page content');
  });
});
