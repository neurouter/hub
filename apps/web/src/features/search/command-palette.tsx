import { useEffect, useId, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { CornerDownLeftIcon, SearchIcon, WrenchIcon } from 'lucide-react';
import type { Me } from '@neurouter/shared';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Kbd } from '@/components/ui/kbd';
import { Spinner } from '@/components/ui/spinner';
import { Pill } from '@/components/status/status';
import { buildNav } from '@/app/nav';
import { catalogToolsQuery } from '@/features/catalog/queries';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { cn } from '@/lib/utils';
import { isPaletteShortcut, matchPages, moveActive, toolItems, type PaletteItem } from './palette';

/** Global ⌘K / Ctrl+K listener (ignored while another modal owns focus is fine: the dialog is modal). */
export function usePaletteShortcut(onOpen: () => void): void {
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!isPaletteShortcut(e)) return;
      e.preventDefault();
      onOpen();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onOpen]);
}

/**
 * ⌘K palette (W8): quick page and tool search. Tools come from `/api/catalog/tools` (hybrid search,
 * ACL-filtered by the backend, relevance order); the palette shows only what the response contains.
 * WAI-ARIA combobox + listbox with aria-activedescendant; arrows / Home / End / Enter / Escape.
 */
export function CommandPalette({ me, open, onOpenChange }: { me: Me; open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const id = useId();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const debounced = useDebouncedValue(q.trim(), 200);
  const toolsEnabled = open && debounced.length >= 2;
  const tools = useQuery({ ...catalogToolsQuery({ q: debounced, limit: 8 }), enabled: toolsEnabled, staleTime: 30_000 });
  const groups = useMemo(() => buildNav(me), [me]);
  const pages = useMemo(() => matchPages(groups, q, q.trim() ? 5 : 8), [groups, q]);
  const toolHits = useMemo(() => (toolsEnabled && tools.data && debounced === q.trim() ? toolItems(tools.data.items) : []), [toolsEnabled, tools.data, debounced, q]);
  const items: PaletteItem[] = useMemo(
    () => [...pages, ...toolHits, ...(q.trim() ? [{ kind: 'search' as const, id: 'search', label: `Search the catalog for “${q.trim()}”`, q: q.trim() }] : [])],
    [pages, toolHits, q],
  );
  const activeIndex = moveActive(active, '', items.length);
  const activeItem = items[activeIndex];

  useEffect(() => {
    if (!activeItem) return;
    document.getElementById(`${id}-${activeItem.id}`)?.scrollIntoView({ block: 'nearest' });
  }, [activeItem, id]);

  function close() {
    onOpenChange(false);
    setQ('');
    setActive(0);
  }

  function choose(it: PaletteItem) {
    close();
    if (it.kind === 'page') void navigate({ to: it.to });
    else if (it.kind === 'tool') void navigate({ to: '/catalog/$serverId', params: { serverId: it.serverId } });
    else void navigate({ to: '/catalog', search: { view: 'tools', q: it.q } });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || ((e.key === 'Home' || e.key === 'End') && e.ctrlKey)) {
      e.preventDefault();
      setActive(moveActive(activeIndex, e.key, items.length));
    } else if (e.key === 'Enter' && activeItem) {
      e.preventDefault();
      choose(activeItem);
    }
  }

  const sections: { title: string; items: PaletteItem[] }[] = [
    { title: 'Pages', items: pages },
    { title: 'Tools', items: toolHits },
    { title: 'More', items: items.filter((i) => i.kind === 'search') },
  ].filter((s) => s.items.length);
  const searching = toolsEnabled && (tools.isFetching || debounced !== q.trim());
  const noTools = toolsEnabled && !searching && tools.data && tools.data.items.length === 0;

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent showCloseButton={false} className="top-[12vh] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogTitle className="sr-only">Search</DialogTitle>
        <DialogDescription className="sr-only">Type to search pages and tools. Use the arrow keys to move and Enter to open.</DialogDescription>
        <div className="flex items-center gap-2 border-b px-3">
          <SearchIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <input
            role="combobox"
            aria-expanded={items.length > 0}
            aria-controls={`${id}-list`}
            aria-activedescendant={activeItem ? `${id}-${activeItem.id}` : undefined}
            aria-autocomplete="list"
            aria-label="Search pages and tools"
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search pages and tools…"
            className="h-12 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
          />
          {searching ? <Spinner className="text-muted-foreground" /> : null}
          <Kbd>Esc</Kbd>
        </div>
        <div id={`${id}-list`} role="listbox" aria-label="Results" className="max-h-[min(60vh,420px)] overflow-y-auto p-1.5">
          {sections.map((s) => (
            <div key={s.title} role="group" aria-labelledby={`${id}-g-${s.title}`} className="pb-1">
              <div id={`${id}-g-${s.title}`} role="presentation" className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                {s.title}
              </div>
              {s.items.map((it) => {
                const on = activeItem?.id === it.id;
                const Icon = it.kind === 'page' ? it.icon : it.kind === 'tool' ? WrenchIcon : SearchIcon;
                return (
                  <div
                    key={it.id}
                    id={`${id}-${it.id}`}
                    role="option"
                    aria-selected={on}
                    onMouseMove={() => setActive(items.indexOf(it))}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(it)}
                    className={cn('flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-[13.5px]', on ? 'bg-accent text-accent-foreground' : '')}
                  >
                    <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                    <span className={cn('min-w-0 truncate', it.kind === 'tool' ? 'font-mono text-[12.5px]' : '')}>{it.label}</span>
                    {it.kind === 'tool' && it.requiresApproval ? <Pill tone="warn">Requires approval</Pill> : null}
                    {it.kind === 'tool' && it.access !== 'allowed' ? <Pill tone="muted">{it.access === 'pending' ? 'Requested' : 'No access'}</Pill> : null}
                    <span className="ml-auto min-w-0 truncate pl-2 text-xs text-muted-foreground">{it.kind === 'search' ? '' : it.hint}</span>
                    {on ? <CornerDownLeftIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" /> : null}
                  </div>
                );
              })}
            </div>
          ))}
          {noTools && pages.length === 0 ? (
            <p role="status" className="px-3 py-6 text-center text-[13px] text-muted-foreground">
              No pages or tools match “{q.trim()}”.
            </p>
          ) : noTools ? (
            <p role="status" className="px-2 pb-2 text-xs text-muted-foreground">
              No tools match “{q.trim()}”.
            </p>
          ) : null}
        </div>
        <div className="hidden items-center gap-3 border-t px-3 py-2 text-xs text-muted-foreground sm:flex">
          <span className="inline-flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> to move
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd>↵</Kbd> to open
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
