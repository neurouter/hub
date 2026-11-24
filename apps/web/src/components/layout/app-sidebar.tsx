import { Link, useRouterState } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { Me } from '@neurouter/shared';
import {
  Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuBadge,
  SidebarMenuButton, SidebarMenuItem, SidebarRail, useSidebar,
} from '@/components/ui/sidebar';
import { buildNav, type BadgeTone, type NavGroupView } from '@/app/nav';
import { badgesQueryOptions } from '@/features/auth/queries';
import { cn } from '@/lib/utils';

// The shadcn badge switches its text to sidebar-accent-foreground when the item is hovered or
// active; keep each tone's own text colour there too, or the count vanishes (dark on primary).
const BADGE_TONE: Record<BadgeTone, string> = {
  default: 'bg-primary text-primary-foreground peer-hover/menu-button:text-primary-foreground peer-data-active/menu-button:text-primary-foreground',
  warning: 'border border-warning/40 bg-warning-muted text-warning peer-hover/menu-button:text-warning peer-data-active/menu-button:text-warning',
  muted: 'bg-muted text-muted-foreground peer-hover/menu-button:text-muted-foreground peer-data-active/menu-button:text-muted-foreground',
};

/** Longest nav target that prefixes the current path wins (so /observability/sessions ≠ Overview). */
export function activeNavId(groups: NavGroupView[], pathname: string): string | null {
  let best: { id: string; len: number } | null = null;
  for (const g of groups)
    for (const item of g.items) {
      const match = pathname === item.to || pathname.startsWith(`${item.to}/`);
      if (match && (!best || item.to.length > best.len)) best = { id: item.id, len: item.to.length };
    }
  return best?.id ?? null;
}

/** Role-adaptive sidebar (approved prototype): logo + org, grouped nav with badges. No footer (addendum #4). */
export function AppSidebar({ me }: { me: Me }) {
  const { data: badges } = useQuery(badgesQueryOptions());
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // On phones the sidebar is a modal sheet: close it once a link is followed, or it keeps
  // covering (and aria-hiding) the page that was just opened.
  const { isMobile, setOpenMobile } = useSidebar();
  const closeOnPhone = () => {
    if (isMobile) setOpenMobile(false);
  };
  const groups = buildNav(me, badges);
  const active = activeNavId(groups, pathname);
  return (
    <Sidebar collapsible="icon">
      {/* a real navigation landmark: aria-label on the sidebar's plain <div> named nothing */}
      <nav aria-label="Main navigation" className="flex min-h-0 flex-1 flex-col">
        <SidebarHeader className="h-14 justify-center">
          <div className="flex items-center gap-2.5 px-1 group-data-[collapsible=icon]:px-0">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <svg viewBox="0 0 24 24" aria-hidden="true" className="size-[18px] fill-none stroke-current stroke-2 [stroke-linecap:round] [stroke-linejoin:round]">
                <path d="M5 19V5l14 14V5" />
              </svg>
            </div>
            <div className="flex min-w-0 flex-1 flex-col leading-tight group-data-[collapsible=icon]:hidden">
              <span className="text-sm font-semibold">Neurouter</span>
              <span className="truncate text-xs text-muted-foreground">{me.org.name}</span>
            </div>
            <span className="rounded-full bg-muted px-1.5 text-[11.5px] font-medium text-muted-foreground tabular-nums group-data-[collapsible=icon]:hidden">
              v{me.version}
            </span>
          </div>
        </SidebarHeader>
        <SidebarContent>
          {groups.map((g) => (
            <SidebarGroup key={g.id} role="group" aria-label={g.label}>
              <SidebarGroupLabel className="flex gap-1.5">
                <span className="flex-1">{g.label}</span>
                {g.note ? <span className="text-[11px] font-medium">{g.note}</span> : null}
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {g.items.map((item) => (
                    <SidebarMenuItem key={item.id}>
                      <SidebarMenuButton
                        isActive={active === item.id}
                        tooltip={item.title}
                        // exact: TanStack marks prefix matches active and forces aria-current="page" on them,
                        // which flagged both Overview and Sessions on /observability/sessions
                        render={<Link to={item.to} onClick={closeOnPhone} activeOptions={{ exact: true, includeSearch: false }} aria-current={active === item.id ? 'page' : undefined} />}
                      >
                        <item.icon />
                        <span>{item.title}</span>
                      </SidebarMenuButton>
                      {item.badge !== null ? (
                        <SidebarMenuBadge className={cn('rounded-full px-1.5 text-[11.5px] font-semibold tabular-nums', BADGE_TONE[item.badgeTone])} aria-label={`${item.badge} pending`}>
                          {item.badge}
                        </SidebarMenuBadge>
                      ) : null}
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>
      </nav>
      <SidebarRail />
    </Sidebar>
  );
}
