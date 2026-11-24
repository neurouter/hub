import { describe, expect, it } from 'vitest';
import { buildExposedName, isValidSlug, parseExposedName } from './naming.js';
import { META_TOOL_DEFINITIONS, SEARCH_TOOLS_NAME } from './meta-tools.js';

describe('slug', () => {
  it.each([
    ['github', true], ['a', true], ['my-server-1', true], ['a'.repeat(32), true],
    ['a'.repeat(33), false], ['-a', false], ['a-', false], ['my_server', false], ['MyServer', false], ['', false],
  ])('%s → %s', (slug, ok) => expect(isValidSlug(slug)).toBe(ok));
});

describe('exposed names', () => {
  it('builds and parses on the first separator', () => {
    expect(buildExposedName('github', 'create_issue')).toBe('github__create_issue');
    expect(parseExposedName('github__weird__name')).toEqual({ slug: 'github', tool: 'weird__name' });
  });
  it('returns null when the name violates the spec SHOULDs', () => {
    expect(buildExposedName('gh', 'has space')).toBeNull();
    expect(buildExposedName('gh', 'x'.repeat(130))).toBeNull();
  });
  it('rejects invalid slugs', () => {
    expect(() => buildExposedName('Bad_Slug', 'x')).toThrow();
    expect(parseExposedName('nosep')).toBeNull();
    expect(parseExposedName('__x')).toBeNull();
    expect(parseExposedName('ok__')).toBeNull();
  });
});

describe('meta-tools', () => {
  it('exposes exactly search_tools and call_tool', () => {
    expect(META_TOOL_DEFINITIONS.map((d) => d.name)).toEqual([SEARCH_TOOLS_NAME, 'call_tool']);
    for (const d of META_TOOL_DEFINITIONS) expect(d.inputSchema.additionalProperties).toBe(false);
  });
});
