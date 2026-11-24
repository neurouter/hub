import { describe, expect, it } from 'vitest';
import { DOCS_DIFF } from '@/mocks/demo-data';
import { summarizeDefinitionChange } from './definition-change';

describe('summarizeDefinitionChange', () => {
  it('summarizes the prototype change (description, +param, limit.maximum, annotation flips)', () => {
    expect(summarizeDefinitionChange(DOCS_DIFF)).toEqual([
      { label: 'Description changed', tone: 'warn' },
      { label: '+1 param · include_drafts', tone: 'warn' },
      { label: 'limit.maximum 50 → 500', tone: 'warn' },
      { label: 'openWorldHint false → true', tone: 'warn' },
      { label: 'readOnlyHint true → false', tone: 'danger' },
    ]);
  });

  it('reports removed params, newly required params and destructiveHint as danger', () => {
    const base = DOCS_DIFF.pinned!;
    const diff = {
      pinned: { ...base, inputSchema: { type: 'object', required: [], properties: { a: { type: 'string' }, b: { type: 'string' } } }, annotations: {} },
      current: { ...DOCS_DIFF.current, description: base.description, title: base.title, inputSchema: { type: 'object', required: ['a'], properties: { a: { type: 'string' } } }, annotations: { destructiveHint: true } },
    };
    expect(summarizeDefinitionChange(diff)).toEqual([
      { label: '−1 param · b', tone: 'warn' },
      { label: 'now required · a', tone: 'warn' },
      { label: 'destructiveHint unset → true', tone: 'danger' },
    ]);
  });

  it('ignores key order and caps constraint chips', () => {
    const props = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`p${i}`, { type: 'integer', maximum: i }]));
    const changed = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`p${i}`, { maximum: i + 1, type: 'integer' }]));
    const base = DOCS_DIFF.pinned!;
    const diff = { pinned: { ...base, inputSchema: { properties: props }, annotations: null }, current: { ...DOCS_DIFF.current, description: base.description, inputSchema: { properties: changed }, annotations: null } };
    const chips = summarizeDefinitionChange(diff);
    expect(chips).toHaveLength(5);
    expect(chips.at(-1)!.label).toBe('+2 more schema changes');
  });

  it('flags a brand-new tool', () => {
    expect(summarizeDefinitionChange({ pinned: null, current: DOCS_DIFF.current })).toEqual([{ label: 'New tool', tone: 'warn' }]);
  });
});
