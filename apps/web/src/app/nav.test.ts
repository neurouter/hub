import { describe, expect, it } from 'vitest';
import { meFixture, badgesFixture } from '@/mocks/fixtures';
import { activeNavId } from '@/components/layout/app-sidebar';
import { buildNav } from './nav';

const shape = (groups: ReturnType<typeof buildNav>) => groups.map((g) => ({ label: g.label, note: g.note, items: g.items.map((i) => i.title) }));

describe('buildNav (sidebar per role, approved prototype)', () => {
  it('user: portal only', () => {
    expect(shape(buildNav(meFixture('user'), badgesFixture()))).toEqual([
      { label: 'Portal', note: null, items: ['Catalog', 'My agents', 'Connections', 'Connect a client', 'My activity', 'My requests'] },
    ]);
  });

  it('admin: everything, no notes', () => {
    expect(shape(buildNav(meFixture('admin'), badgesFixture()))).toEqual([
      { label: 'Portal', note: null, items: ['Catalog', 'My agents', 'Connections', 'Connect a client', 'My activity', 'My requests'] },
      { label: 'Review', note: null, items: ['Approvals', 'Access requests'] },
      { label: 'Administration', note: null, items: ['Users', 'Groups', 'Agents', 'Servers', 'Library', 'Tools', 'Access control'] },
      { label: 'Audit & observability', note: null, items: ['Overview', 'Sessions', 'Audit log'] },
      { label: 'Settings', note: null, items: ['Gateway settings'] },
    ]);
  });

  it('auditor: read-only administration and settings, no review queue', () => {
    expect(shape(buildNav(meFixture('auditor'), badgesFixture()))).toEqual([
      { label: 'Portal', note: null, items: ['Catalog', 'My agents', 'Connections', 'Connect a client', 'My activity', 'My requests'] },
      { label: 'Administration', note: 'read-only', items: ['Users', 'Groups', 'Agents', 'Servers', 'Tools', 'Access control'] },
      { label: 'Audit & observability', note: null, items: ['Overview', 'Sessions', 'Audit log'] },
      { label: 'Settings', note: 'read-only', items: ['Gateway settings'] },
    ]);
    const tools = buildNav(meFixture('auditor'), badgesFixture()).flatMap((g) => g.items).find((i) => i.id === 'tools');
    expect(tools?.badge).toBeNull();
  });

  it('server owner: review + owned administration + scoped observability', () => {
    expect(shape(buildNav(meFixture('owner'), badgesFixture()))).toEqual([
      { label: 'Portal', note: null, items: ['Catalog', 'My agents', 'Connections', 'Connect a client', 'My activity', 'My requests'] },
      { label: 'Review', note: null, items: ['Approvals', 'Access requests'] },
      { label: 'Administration', note: 'owned', items: ['My servers', 'Tools', 'Access control'] },
      { label: 'Audit & observability', note: 'my servers', items: ['Overview', 'Sessions', 'Audit log'] },
    ]);
  });

  it('maps badge counts and tones, hiding zeros', () => {
    const items = buildNav(meFixture('admin'), badgesFixture({ pendingApprovals: 4, toolsPendingReview: 2, myPendingRequests: 0, brokenConnections: 1 })).flatMap((g) => g.items);
    const by = (id: string) => items.find((i) => i.id === id)!;
    expect([by('approvals').badge, by('approvals').badgeTone]).toEqual([4, 'default']);
    expect([by('tools').badge, by('tools').badgeTone]).toEqual([2, 'warning']);
    expect([by('connections').badge, by('connections').badgeTone]).toEqual([1, 'warning']);
    expect(by('requests').badge).toBeNull();
    expect(buildNav(meFixture('admin'), null).flatMap((g) => g.items).every((i) => i.badge === null)).toBe(true);
  });

  it('hides Phase 2 items unless the feature flag is on', () => {
    const off = buildNav(meFixture('user')).flatMap((g) => g.items).map((i) => i.id);
    expect(off).not.toContain('skills');
    const on = buildNav(meFixture('user', { features: { skills: true, favorites: false, toolSearch: true, oauthClients: true } })).flatMap((g) => g.items).map((i) => i.id);
    expect(on).toContain('skills');
  });

  it('picks the most specific active item', () => {
    const groups = buildNav(meFixture('admin'));
    expect(activeNavId(groups, '/observability/sessions/abc')).toBe('sessions');
    expect(activeNavId(groups, '/observability')).toBe('overview');
    expect(activeNavId(groups, '/admin/servers/1')).toBe('servers');
    expect(activeNavId(groups, '/nowhere')).toBeNull();
  });
});
