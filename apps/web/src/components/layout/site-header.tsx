import { Fragment, useCallback, useState } from 'react';
import { useMatches } from '@tanstack/react-router';
import { SearchIcon } from 'lucide-react';
import { isReadOnly, type Me } from '@neurouter/shared';
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb';
import { Kbd } from '@/components/ui/kbd';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { CommandPalette, usePaletteShortcut } from '@/features/search/command-palette';
import { UserMenu } from './user-menu';

/** Top bar (approved prototype Topbar.dc.html): trigger · breadcrumbs · read-only · search · theme · user. */
export function SiteHeader({ me }: { me: Me }) {
  const matches = useMatches();
  const [paletteOpen, setPaletteOpen] = useState(false);
  usePaletteShortcut(useCallback(() => setPaletteOpen(true), []));
  const meta = [...matches].reverse().find((m) => m.staticData?.crumbs)?.staticData;
  const crumbs = meta?.crumbs ?? [];
  const readOnly = [...matches].some((m) => m.staticData?.readOnly && isReadOnly(me, m.staticData.readOnly.read, m.staticData.readOnly.write));
  return (
    <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4">
      <SidebarTrigger className="size-8" aria-label="Toggle sidebar (Ctrl+B)" />
      <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-4" />
      <Breadcrumb className="min-w-0 flex-1">
        <BreadcrumbList className="flex-nowrap overflow-hidden whitespace-nowrap">
          {crumbs.map((c, i) => (
            <Fragment key={`${c}-${i}`}>
              <BreadcrumbItem className={i < crumbs.length - 1 ? 'hidden sm:inline-flex' : undefined}>
                {i === crumbs.length - 1 ? <BreadcrumbPage>{c}</BreadcrumbPage> : <span>{c}</span>}
              </BreadcrumbItem>
              {i < crumbs.length - 1 ? <BreadcrumbSeparator className="hidden sm:inline-flex" /> : null}
            </Fragment>
          ))}
        </BreadcrumbList>
      </Breadcrumb>
      {readOnly ? (
        <span className="inline-flex h-[22px] items-center rounded-full border border-warning/40 bg-warning-muted px-2 text-xs font-medium text-warning">
          Read-only
        </span>
      ) : null}
      <button
        type="button"
        aria-label="Search pages and tools"
        aria-keyshortcuts="Meta+K Control+K"
        onClick={() => setPaletteOpen(true)}
        className="hidden h-8 w-64 items-center gap-2 rounded-lg border bg-background pr-1.5 pl-2.5 text-[13px] text-muted-foreground hover:bg-accent md:inline-flex"
      >
        <SearchIcon className="size-4" />
        <span className="flex-1 text-left">Search servers, tools…</span>
        <Kbd>⌘K</Kbd>
      </button>
      <button
        type="button"
        aria-label="Search"
        onClick={() => setPaletteOpen(true)}
        className="inline-flex size-8 items-center justify-center rounded-lg text-foreground hover:bg-accent md:hidden"
      >
        <SearchIcon className="size-[18px]" />
      </button>
      <CommandPalette me={me} open={paletteOpen} onOpenChange={setPaletteOpen} />
      <ThemeToggle />
      <UserMenu me={me} />
    </header>
  );
}
