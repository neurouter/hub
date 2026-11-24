import { describe, expect, it } from 'vitest';
import { auditExportUrl } from './download';
import { sortKeysDeep, stableStringify } from './json';

describe('auditExportUrl', () => {
  it('carries exactly the active filters plus the format', () => {
    const url = auditExportUrl(
      { from: '2026-11-23T10:00:00.000Z', to: '2026-11-24T10:00:00.000Z', agentId: 'a1', decision: ['denied_acl', 'approval_denied'], q: undefined, kind: ['tool_call'] },
      'csv',
    );
    expect(url).toBe(
      '/api/audit/export?from=2026-11-23T10%3A00%3A00.000Z&to=2026-11-24T10%3A00%3A00.000Z&agentId=a1&decision=denied_acl&decision=approval_denied&kind=tool_call&format=csv',
    );
  });
});

describe('stable JSON', () => {
  it('sorts object keys deeply but keeps array order', () => {
    expect(sortKeysDeep({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 2 } })).toEqual({ a: { c: 2, d: [3, { y: 2, z: 1 }] }, b: 1 });
    expect(stableStringify({ b: 1, a: 2 })).toBe('{\n  "a": 2,\n  "b": 1\n}');
    expect(stableStringify(null)).toBe('');
  });
});
