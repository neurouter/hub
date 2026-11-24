import type { LucideIcon } from 'lucide-react';
import type { CatalogTool } from '@neurouter/shared';
import type { NavGroupView } from '@/app/nav';

/** One selectable row of the ⌘K palette. */
export type PaletteItem =
  | { kind: 'page'; id: string; label: string; hint: string; to: string; icon: LucideIcon }
  | { kind: 'tool'; id: string; label: string; hint: string; serverId: string; requiresApproval: boolean; access: CatalogTool['access'] }
  | { kind: 'search'; id: string; label: string; q: string };

const norm = (s: string) => s.toLowerCase().normalize('NFKD');

/**
 * Pages the user can open (the role-filtered sidebar IA), matched on title or group. Every word of
 * the query must appear. Empty query → all pages in sidebar order.
 */
export function matchPages(groups: readonly NavGroupView[], q: string, limit = 8): PaletteItem[] {
  const words = norm(q).split(/\s+/).filter(Boolean);
  const out: PaletteItem[] = [];
  for (const g of groups)
    for (const it of g.items) {
      const hay = norm(`${it.title} ${g.label}`);
      if (words.every((w) => hay.includes(w))) out.push({ kind: 'page', id: `page:${it.id}`, label: it.title, hint: g.label, to: it.to, icon: it.icon });
    }
  return out.slice(0, limit);
}

/** Tool hits keep the server's relevance order (the UI never shows scores). */
export function toolItems(tools: readonly CatalogTool[]): PaletteItem[] {
  return tools.map((t) => ({
    kind: 'tool',
    id: `tool:${t.id}`,
    label: t.qualifiedName,
    hint: t.title ?? t.description,
    serverId: t.server.id,
    requiresApproval: t.requiresApproval,
    access: t.access,
  }));
}

/** Wrapping arrow-key movement; Home/End jump. Returns -1 for an empty list. */
export function moveActive(index: number, key: string, count: number): number {
  if (count === 0) return -1;
  switch (key) {
    case 'ArrowDown':
      return (index + 1 + count) % count;
    case 'ArrowUp':
      return index <= 0 ? count - 1 : index - 1;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return Math.min(Math.max(index, 0), count - 1);
  }
}

/** Is this keydown the palette shortcut (⌘K on macOS, Ctrl+K elsewhere)? */
export function isPaletteShortcut(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k';
}
