import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { reloadDisplayPrefs } from '@/lib/display-prefs';
import { server } from './msw-server';

/** Controllable matchMedia (jsdom has none): set `window.__media` keys to true to match. */
const listeners = new Set<{ query: string; fn: (e: MediaQueryListEvent) => void }>();
const media: Record<string, boolean> = {};
export function setMedia(query: string, matches: boolean): void {
  media[query] = matches;
  for (const l of listeners) if (l.query === query) l.fn({ matches, media: query } as MediaQueryListEvent);
}
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string): MediaQueryList =>
    ({
      get matches() {
        return media[query] ?? false;
      },
      media: query,
      onchange: null,
      addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => listeners.add({ query, fn }),
      removeEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => {
        for (const l of listeners) if (l.fn === fn) listeners.delete(l);
      },
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList,
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
/**
 * jsdom has no layout (clientWidth/clientHeight are always 0). Virtualized scroll containers
 * opt in with `data-virtual-scroll` and get a viewport-sized box so @tanstack/react-virtual renders rows.
 */
for (const [prop, size] of [['clientHeight', 900], ['clientWidth', 1200]] as const) {
  Object.defineProperty(HTMLElement.prototype, prop, {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute('data-virtual-scroll') ? size : 0;
    },
  });
}

globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= vi.fn();
Element.prototype.scrollTo ??= vi.fn() as never;
window.scrollTo = vi.fn() as never;

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  for (const k of Object.keys(media)) delete media[k];
  listeners.clear();
  try {
    window.localStorage.clear();
  } catch {
    // ignore
  }
  document.documentElement.className = '';
  document.documentElement.removeAttribute('style');
  reloadDisplayPrefs(); // storage was cleared: back to local time, comfortable density
});
afterAll(() => server.close());
