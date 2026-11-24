import { describe, expect, it } from 'vitest';
import { parseExposedName } from '@neurouter/shared';
import { exposedNameFor } from './naming.js';
import { definitionOf, hashDefinition, invalidHeaderAnnotation, searchTextOf } from './tool-hash.js';

describe('exposed names', () => {
  it('uses slug__name when valid, splitting on the first __', () => {
    expect(exposedNameFor('github', 'create_issue')).toEqual({ name: 'github__create_issue', aliased: false });
    const n = exposedNameFor('gh', 'weird__name').name;
    expect(parseExposedName(n)).toEqual({ slug: 'gh', tool: 'weird__name' });
  });
  it('aliases invalid characters and long names, stably and uniquely', () => {
    const a = exposedNameFor('gh', 'has space/slash');
    expect(a.aliased).toBe(true);
    expect(a.name).toMatch(/^gh__has_space_slash_[a-z2-7]{6}$/);
    expect(exposedNameFor('gh', 'has space/slash')).toEqual(a);
    expect(exposedNameFor('gh', 'has space?slash').name).not.toBe(a.name);
    const long = exposedNameFor('server', 'x'.repeat(200));
    expect(long.name.length).toBeLessThanOrEqual(128);
    expect(long.name).toMatch(/^[A-Za-z0-9_.-]+$/);
  });
});

describe('tool hash', () => {
  it('is stable under key order (JCS) and sensitive to content', () => {
    const a = definitionOf({ name: 't', description: 'd', inputSchema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } } });
    const b = definitionOf({ description: 'd', name: 't', inputSchema: { properties: { b: { type: 'number' }, a: { type: 'string' } }, type: 'object' } } as never);
    expect(hashDefinition(a)).toBe(hashDefinition(b));
    expect(hashDefinition({ ...a, description: 'e' })).not.toBe(hashDefinition(a));
  });
  it.each([
    [{ type: 'object', properties: { a: { type: 'string', 'x-mcp-header': 'Repo' } } }, null],
    [{ type: 'object', properties: { a: { type: 'string', 'x-mcp-header': 'bad header' } } }, /invalid/],
    [{ type: 'object', properties: { a: { type: 'string', 'x-mcp-header': 'R' }, b: { type: 'string', 'x-mcp-header': 'r' } } }, /duplicate/],
    [{ type: 'object', properties: { a: { type: 'object', 'x-mcp-header': 'R' } } }, /primitive/],
  ])('x-mcp-header %#', (schema, expected) => {
    const r = invalidHeaderAnnotation(schema);
    if (expected === null) expect(r).toBeNull();
    else expect(r).toMatch(expected);
  });
  it('builds search text from nested params', () => {
    expect(searchTextOf({ inputSchema: { properties: { repo: { description: 'Repository name', properties: { owner: {} } } } } })).toBe('repo owner\nRepository name');
  });
});
