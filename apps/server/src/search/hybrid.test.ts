import { describe, expect, it } from 'vitest';
import { EXACT_MATCH_BOOST, fuseRankings, RRF_K } from './hybrid.js';
import { paramInfo, toolDocument, textHash, MAX_DOCUMENT_CHARS } from './document.js';
import { modelProfile, DEFAULT_EMBEDDING_MODEL } from './model-profiles.js';

const names = new Map([
  ['a', 'srv__alpha'],
  ['b', 'srv__beta'],
  ['c', 'srv__gamma'],
  ['d', 'srv__delta'],
]);
const all = new Set(names.keys());

describe('fuseRankings (RRF)', () => {
  it('sums 1/(k+rank) across lists with 1-based ranks', () => {
    const out = fuseRankings({ lists: [['a', 'b'], ['b', 'c']], allowed: all, names, limit: 10 });
    expect(out.map((o) => o.id)).toEqual(['b', 'a', 'c']);
    expect(out[0]!.score).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1));
    expect(out[1]!.score).toBeCloseTo(1 / (RRF_K + 1));
  });

  it('never returns ids outside the allowed set, even when a list contains them', () => {
    const out = fuseRankings({ lists: [['d', 'a'], ['d']], allowed: new Set(['a', 'b']), names, exact: new Set(['d']), favorites: new Map([['d', 100]]), limit: 10 });
    expect(out.map((o) => o.id)).toEqual(['a']);
    // the forbidden id still consumed rank 1, so 'a' is scored at rank 2 (ranks come from the ACL-filtered DB lists anyway)
    expect(out[0]!.score).toBeCloseTo(1 / (RRF_K + 2));
  });

  it('puts exact name matches first and breaks ties by name', () => {
    const out = fuseRankings({ lists: [['c', 'b']], allowed: all, names, exact: new Set(['b']), limit: 10 });
    expect(out[0]).toMatchObject({ id: 'b', score: EXACT_MATCH_BOOST + 1 / (RRF_K + 2) });
    const ties = fuseRankings({ lists: [['c'], ['a']], allowed: all, names, limit: 10 });
    expect(ties.map((t) => t.id)).toEqual(['a', 'c']);
  });

  it('applies the favorites boost (β·fav/(1+fav)) only to ranked candidates, and the limit', () => {
    const out = fuseRankings({ lists: [['a', 'b']], allowed: all, names, favorites: new Map([['b', 9], ['c', 9]]), limit: 1 });
    expect(out).toHaveLength(1);
    // one rank step near the top is ~0.00026; the boost (0.009) lifts b above a
    expect(out[0]!.id).toBe('b');
  });

  it('dedupes repeated ids within a list', () => {
    const out = fuseRankings({ lists: [['a', 'a', 'b']], allowed: all, names, limit: 10 });
    expect(out.find((o) => o.id === 'b')!.score).toBeCloseTo(1 / (RRF_K + 2));
  });
});

describe('search documents', () => {
  it('collects parameter names up to depth 3 and their descriptions', () => {
    const schema = { type: 'object', properties: { repo: { type: 'string', description: 'Repository' }, opts: { type: 'object', properties: { labels: { type: 'array', items: { type: 'object', properties: { name: { type: 'string', description: 'Label' } } } } } } } };
    const p = paramInfo(schema);
    expect(p.names).toEqual(['repo', 'opts', 'opts.labels', 'opts.labels.name']);
    expect(p.descriptions).toEqual(['repo: Repository', 'opts.labels.name: Label']);
  });

  it('builds the §11.1 document and caps it at 2,000 chars', () => {
    const doc = toolDocument({ exposedName: 'gh__create_issue', title: 'Create issue', description: 'Create a GitHub issue', inputSchema: { properties: { repo: { description: 'Repository' } } } });
    expect(doc).toBe('gh__create_issue\nCreate issue\nCreate a GitHub issue\nparameters: repo\nrepo: Repository');
    expect(toolDocument({ exposedName: 'x', title: null, description: 'y'.repeat(5000), inputSchema: null })).toHaveLength(MAX_DOCUMENT_CHARS);
  });

  it('text hash changes with the document or the model id', () => {
    expect(textHash('doc', 'm1')).toBe(textHash('doc', 'm1'));
    expect(textHash('doc', 'm1')).not.toBe(textHash('doc', 'm2'));
    expect(textHash('doc', 'm1')).not.toBe(textHash('doc2', 'm1'));
  });

  it('model profiles: granite uses CLS pooling and no query prefix; unknown models fall back to mean', () => {
    expect(modelProfile(DEFAULT_EMBEDDING_MODEL, 384)).toEqual({ pooling: 'cls', queryPrefix: '', dims: 384 });
    expect(modelProfile('Xenova/bge-small-en-v1.5', 384).queryPrefix).toMatch(/^Represent this sentence/);
    expect(modelProfile('org/other', 768)).toEqual({ pooling: 'mean', queryPrefix: '', dims: 768 });
  });
});
