import type { LucideIcon } from 'lucide-react';
import {
  ActivityIcon, BotIcon, ClockIcon, FileTextIcon, InboxIcon, LayoutGridIcon, LineChartIcon, LinkIcon, ListIcon,
  PlugIcon, ServerIcon, ShieldCheckIcon, SlidersHorizontalIcon, SquareIcon, UserPlusIcon, UsersIcon, WrenchIcon,
} from 'lucide-react';
import { can, isAuditor, isOwnerScoped, isReadOnly, type BadgeKey, type Badges, type Capability, type Features, type Me } from '@neurouter/shared';

export type BadgeTone = 'default' | 'warning' | 'muted';

export interface NavItemDef {
  id: string;
  title: string;
  /** Title when the user only sees owned resources (Server Owner without global access). */
  ownerTitle?: string;
  to: string;
  icon: LucideIcon;
  capability: Capability;
  badgeKey?: BadgeKey;
  badgeTone?: BadgeTone;
  /** Hide the badge for users who can only read (e.g. Auditors see no "needs review" counts). */
  badgeRequires?: Capability;
  phase?: 2;
  feature?: keyof Features;
}

export interface NavGroupDef {
  id: string;
  label: string;
  items: NavItemDef[];
  /** Note shown next to the label (prototype): "owned", "my servers", "read-only". */
  note?: (me: Me) => string | null;
}

/** Sidebar IA (frontend §3.3, approved prototype Sidebar.dc.html). */
export const NAV: readonly NavGroupDef[] = [
  {
    id: 'portal',
    label: 'Portal',
    items: [
      { id: 'catalog', title: 'Catalog', to: '/catalog', icon: LayoutGridIcon, capability: 'portal:use' },
      { id: 'agents', title: 'My agents', to: '/agents', icon: BotIcon, capability: 'portal:use' },
      { id: 'connections', title: 'Connections', to: '/connections', icon: LinkIcon, capability: 'portal:use', badgeKey: 'brokenConnections', badgeTone: 'warning' },
      { id: 'connect', title: 'Connect a client', to: '/connect', icon: PlugIcon, capability: 'portal:use' },
      { id: 'activity', title: 'My activity', to: '/activity', icon: ActivityIcon, capability: 'portal:use' },
      { id: 'requests', title: 'My requests', to: '/requests', icon: InboxIcon, capability: 'portal:use', badgeKey: 'myPendingRequests', badgeTone: 'muted' },
      { id: 'skills', title: 'Skills', to: '/skills', icon: SquareIcon, capability: 'portal:use', phase: 2, feature: 'skills' },
    ],
  },
  {
    id: 'review',
    label: 'Review',
    items: [
      { id: 'approvals', title: 'Approvals', to: '/admin/approvals', icon: ClockIcon, capability: 'approvals:review', badgeKey: 'pendingApprovals' },
      { id: 'access-requests', title: 'Access requests', to: '/admin/access-requests', icon: UserPlusIcon, capability: 'accessRequests:review', badgeKey: 'pendingAccessRequests' },
    ],
  },
  {
    id: 'admin',
    label: 'Administration',
    note: (me) => (isOwnerScoped(me, 'servers:read') ? 'owned' : isReadOnly(me, 'servers:read', 'servers:write') && isAuditor(me) ? 'read-only' : null),
    items: [
      { id: 'users', title: 'Users', to: '/admin/users', icon: UsersIcon, capability: 'users:read' },
      { id: 'groups', title: 'Groups', to: '/admin/groups', icon: ListIcon, capability: 'groups:read' },
      { id: 'agents-all', title: 'Agents', to: '/admin/agents', icon: BotIcon, capability: 'agents:readAll' },
      { id: 'servers', title: 'Servers', ownerTitle: 'My servers', to: '/admin/servers', icon: ServerIcon, capability: 'servers:read' },
      { id: 'tools', title: 'Tools', to: '/admin/tools', icon: WrenchIcon, capability: 'tools:read', badgeKey: 'toolsPendingReview', badgeTone: 'warning', badgeRequires: 'tools:write' },
      { id: 'acl', title: 'Access control', to: '/admin/access-control', icon: ShieldCheckIcon, capability: 'grants:read' },
    ],
  },
  {
    id: 'observability',
    label: 'Audit & observability',
    note: (me) => (isOwnerScoped(me, 'audit:read') ? 'my servers' : null),
    items: [
      { id: 'overview', title: 'Overview', to: '/observability', icon: LineChartIcon, capability: 'metrics:read' },
      { id: 'sessions', title: 'Sessions', to: '/observability/sessions', icon: SlidersHorizontalIcon, capability: 'sessions:read' },
      { id: 'audit', title: 'Audit log', to: '/audit', icon: FileTextIcon, capability: 'audit:read' },
    ],
  },
  {
    id: 'settings',
    label: 'Settings',
    note: (me) => (isReadOnly(me, 'settings:read', 'settings:write') ? 'read-only' : null),
    items: [{ id: 'gateway-settings', title: 'Gateway settings', to: '/admin/settings', icon: SlidersHorizontalIcon, capability: 'settings:read' }],
  },
];

export interface NavItemView {
  id: string;
  title: string;
  to: string;
  icon: LucideIcon;
  badge: number | null;
  badgeTone: BadgeTone;
}

export interface NavGroupView {
  id: string;
  label: string;
  note: string | null;
  items: NavItemView[];
}

/** Filters the IA for a user: a group renders only if at least one item passes `can()`. */
export function buildNav(me: Me, badges?: Partial<Badges> | null, nav: readonly NavGroupDef[] = NAV): NavGroupView[] {
  const groups: NavGroupView[] = [];
  for (const g of nav) {
    const items: NavItemView[] = [];
    for (const item of g.items) {
      if (item.phase === 2 && !(item.feature && me.features[item.feature])) continue;
      if (!can(me, item.capability)) continue;
      const showBadge = item.badgeKey && (!item.badgeRequires || can(me, item.badgeRequires));
      const count = showBadge && badges ? (badges[item.badgeKey!] ?? 0) : 0;
      items.push({
        id: item.id,
        title: item.ownerTitle && isOwnerScoped(me, item.capability) ? item.ownerTitle : item.title,
        to: item.to,
        icon: item.icon,
        badge: count > 0 ? count : null,
        badgeTone: item.badgeTone ?? 'default',
      });
    }
    if (items.length) groups.push({ id: g.id, label: g.label, note: g.note?.(me) ?? null, items });
  }
  return groups;
}
