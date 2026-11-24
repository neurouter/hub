import { Link } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { LogOutIcon, PaletteIcon, UserIcon } from 'lucide-react';
import { api, displayRoles, type Me } from '@neurouter/shared';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { apiFetch } from '@/lib/api-client';
import { browserNavigation } from '@/lib/navigation';
import { avatarColor, initials } from '@/lib/initials';

const ROLE_LABEL = { admin: 'Admin', auditor: 'Auditor', owner: 'Server owner', user: 'User' } as const;

export async function signOut(queryClient: { clear: () => void }, navigate: (url: string) => void = (u) => browserNavigation.assign(u)) {
  let redirectTo = '/auth/logged-out';
  try {
    redirectTo = (await apiFetch(api.auth.logout)).redirectTo;
  } catch {
    // session already gone: still leave the app
  }
  queryClient.clear();
  navigate(redirectTo);
}

/** Avatar button in the top bar (approved prototype, addendum #4). */
export function UserMenu({ me }: { me: Me }) {
  const queryClient = useQueryClient();
  const roles = displayRoles(me).map((r) => ROLE_LABEL[r]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Open user menu"
        className="flex size-8 items-center justify-center rounded-full text-xs font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background data-popup-open:ring-2 data-popup-open:ring-ring data-popup-open:ring-offset-2 data-popup-open:ring-offset-background"
        style={{ background: avatarColor(me.user.id) }}
      >
        {initials(me.user.name, me.user.email)}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col gap-0.5 font-normal">
            <span className="text-sm font-semibold text-foreground">{me.user.name || me.user.email}</span>
            <span className="truncate text-xs text-muted-foreground">{me.user.email}</span>
            <span className="text-xs text-muted-foreground">{roles.join(' · ')}</span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem render={<Link to="/settings/profile" />}>
            <UserIcon /> Profile
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link to="/settings/appearance" />}>
            <PaletteIcon /> Appearance
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void signOut(queryClient)}>
          <LogOutIcon /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
