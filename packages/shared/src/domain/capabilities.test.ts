import { describe, expect, it } from 'vitest';
import { ALL_CAPABILITIES, can, canAny, capabilitiesFor, isOwnerScoped, isReadOnly, type Capability } from './capabilities.js';
import { displayRoles, primaryRole, type RoleSubject } from './roles.js';

const admin: RoleSubject = { roles: ['admin'], ownedServerIds: [] };
const auditor: RoleSubject = { roles: ['auditor'], ownedServerIds: [] };
const owner: RoleSubject = { roles: [], ownedServerIds: ['s1'] };
const user: RoleSubject = { roles: [], ownedServerIds: [] };

describe('capabilitiesFor', () => {
  it('admin has every capability', () => {
    expect(capabilitiesFor(admin)).toEqual([...ALL_CAPABILITIES]);
  });
  it('plain user only has portal:use', () => {
    expect(capabilitiesFor(user)).toEqual(['portal:use']);
  });
  it('auditor is read-only', () => {
    const caps = capabilitiesFor(auditor);
    for (const c of caps) expect(c).not.toMatch(/:(write|create|review)$/);
    expect(caps).toContain('audit:verify');
    expect(caps).toContain('settings:read');
  });
  it('owner gets owner-scoped capabilities but never servers:create or audit:verify', () => {
    const caps = capabilitiesFor(owner);
    expect(caps).toContain('servers:write');
    expect(caps).toContain('approvals:review');
    expect(caps).not.toContain('servers:create');
    expect(caps).not.toContain('audit:verify');
    expect(caps).not.toContain('users:read');
  });
});

describe('can() matrix', () => {
  const table: Array<[string, RoleSubject, Capability, { serverId?: string | null } | undefined, boolean]> = [
    ['admin any', admin, 'servers:create', undefined, true],
    ['admin foreign server', admin, 'servers:write', { serverId: 'x' }, true],
    ['auditor read any server', auditor, 'servers:read', { serverId: 'x' }, true],
    ['auditor cannot write', auditor, 'servers:write', { serverId: 'x' }, false],
    ['auditor cannot review approvals', auditor, 'approvals:review', undefined, false],
    ['owner area access', owner, 'tools:write', undefined, true],
    ['owner owned server', owner, 'tools:write', { serverId: 's1' }, true],
    ['owner foreign server', owner, 'tools:write', { serverId: 's2' }, false],
    ['owner null server', owner, 'grants:write', { serverId: null }, false],
    ['owner cannot create servers', owner, 'servers:create', undefined, false],
    ['owner cannot read users', owner, 'users:read', undefined, false],
    ['user portal', user, 'portal:use', undefined, true],
    ['user no audit', user, 'audit:read', undefined, false],
    ['user no servers', user, 'servers:read', { serverId: 's1' }, false],
  ];
  it.each(table)('%s', (_name, subject, cap, resource, expected) => {
    expect(can(subject, cap, resource)).toBe(expected);
  });

  it('auditor + owner can still write owned servers', () => {
    const both: RoleSubject = { roles: ['auditor'], ownedServerIds: ['s1'] };
    expect(can(both, 'servers:write', { serverId: 's1' })).toBe(true);
    expect(can(both, 'servers:write', { serverId: 's2' })).toBe(false);
    expect(can(both, 'servers:read', { serverId: 's2' })).toBe(true);
  });

  it('canAny, isOwnerScoped, isReadOnly', () => {
    expect(canAny(user, ['audit:read', 'portal:use'])).toBe(true);
    expect(isOwnerScoped(owner, 'audit:read')).toBe(true);
    expect(isOwnerScoped(auditor, 'audit:read')).toBe(false);
    expect(isOwnerScoped(admin, 'audit:read')).toBe(false);
    expect(isReadOnly(auditor, 'users:read', 'users:write')).toBe(true);
    expect(isReadOnly(admin, 'users:read', 'users:write')).toBe(false);
  });
});

describe('display roles', () => {
  it('orders roles and always includes user', () => {
    expect(displayRoles({ roles: ['auditor', 'admin'], ownedServerIds: ['s'] })).toEqual(['admin', 'auditor', 'owner', 'user']);
    expect(primaryRole(owner)).toBe('owner');
    expect(primaryRole(user)).toBe('user');
  });
});
