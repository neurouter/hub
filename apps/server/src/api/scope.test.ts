import { describe, expect, it } from 'vitest';
import type { UserSubject } from '../identity/principal.js';
import { resolveScope, rowVisible } from './scope.js';

const subj = (o: Partial<UserSubject>): UserSubject => ({ id: 'me', email: 'me@x', name: 'me', avatarUrl: null, status: 'active', roles: [], groups: [], ownedServerIds: [], preferences: {}, ...o });
const admin = subj({ roles: ['admin'] });
const auditor = subj({ roles: ['auditor'] });
const owner = subj({ ownedServerIds: ['s1', 's2'] });
const user = subj({});

describe('forced scoping (audit, metrics, sessions)', () => {
  it('admins and auditors see everything; explicit filters pass through; scope=me narrows', () => {
    for (const v of [admin, auditor]) {
      expect(resolveScope(v, 'audit:read', {})).toEqual({ mode: 'all' });
      expect(resolveScope(v, 'metrics:read', { serverId: 'x', userId: 'u' })).toEqual({ mode: 'all', serverIds: ['x'], userId: 'u' });
      expect(resolveScope(v, 'sessions:read', { scope: 'me' })).toEqual({ mode: 'me', userId: 'me' });
    }
  });

  it('owners are forced to owned servers; a foreign serverId is 403; scope=me gives own rows', () => {
    expect(resolveScope(owner, 'audit:read', {})).toEqual({ mode: 'owner', serverIds: ['s1', 's2'] });
    expect(resolveScope(owner, 'audit:export', { serverId: 's2', userId: 'u9' })).toEqual({ mode: 'owner', serverIds: ['s2'], userId: 'u9' });
    expect(() => resolveScope(owner, 'metrics:read', { serverId: 's3' })).toThrow(expect.objectContaining({ code: 'forbidden' }));
    expect(resolveScope(owner, 'audit:read', { scope: 'me' })).toEqual({ mode: 'me', userId: 'me' });
  });

  it('plain users always get scope=me (their userId filter is ignored); export is forbidden', () => {
    expect(resolveScope(user, 'audit:read', { userId: 'someone-else' })).toEqual({ mode: 'me', userId: 'me' });
    expect(resolveScope(user, 'metrics:read', { serverId: 's1' })).toEqual({ mode: 'me', userId: 'me', serverIds: ['s1'] });
    expect(() => resolveScope(user, 'audit:export', {})).toThrow(expect.objectContaining({ code: 'forbidden' }));
  });

  it('row visibility follows the scope', () => {
    expect(rowVisible({ mode: 'owner', serverIds: ['s1'] }, { serverId: 's1', userId: 'x' })).toBe(true);
    expect(rowVisible({ mode: 'owner', serverIds: ['s1'] }, { serverId: null, userId: 'x' })).toBe(false);
    expect(rowVisible({ mode: 'me', userId: 'me' }, { serverId: 's9', userId: 'me' })).toBe(true);
    expect(rowVisible({ mode: 'me', userId: 'me' }, { serverId: 's9', userId: 'other' })).toBe(false);
    expect(rowVisible({ mode: 'all' }, { serverId: null, userId: null })).toBe(true);
  });
});
