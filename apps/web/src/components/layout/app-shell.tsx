import { useState, type ReactNode } from 'react';
import { can, type Me } from '@neurouter/shared';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { ApprovalsLiveProvider } from '@/features/approvals/live';
import { readStorage, writeStorage } from '@/lib/storage';
import { AppSidebar } from './app-sidebar';
import { DemoBanner } from './demo-banner';
import { SiteHeader } from './site-header';

export const SIDEBAR_STORAGE_KEY = 'neurouter-sidebar-open';

function initialOpen(): boolean {
  const stored = readStorage(SIDEBAR_STORAGE_KEY);
  if (stored === 'true' || stored === 'false') return stored === 'true';
  // tablet (768–1279) starts collapsed to icons, desktop expanded (frontend §3.3)
  return typeof window.matchMedia !== 'function' || window.matchMedia('(min-width: 1280px)').matches;
}

/** Authenticated layout: skip link, sidebar, sticky top bar and the page in <main>. */
export function AppShell({ me, children }: { me: Me; children: ReactNode }) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <ApprovalsLiveProvider enabled={can(me, 'approvals:review')}>
    <SidebarProvider
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        writeStorage(SIDEBAR_STORAGE_KEY, String(v));
      }}
    >
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:shadow">
        Skip to content
      </a>
      <AppSidebar me={me} />
      <SidebarInset className="min-w-0">
        <DemoBanner />
        <SiteHeader me={me} />
        <main id="main" className="mx-auto flex w-full max-w-screen-2xl flex-1 flex-col gap-5 px-4 pt-6 pb-10 md:px-8">
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
    </ApprovalsLiveProvider>
  );
}
