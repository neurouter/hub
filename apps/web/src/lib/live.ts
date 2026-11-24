/**
 * LiveChannel (frontend §6.4): an `EventSource` wrapper with a status the consumer uses to switch
 * to polling.
 *
 * - `open` once the stream is connected; `degraded` after `maxErrors` consecutive errors (or when
 *   the browser has no EventSource), at which point the consumer polls; it recovers to `open` when
 *   the stream reconnects.
 * - When the browser closes the stream for good (non-200 response), it is re-created after `retryMs`.
 * - Hidden for more than `hiddenPauseMs` → the stream is closed (`paused`); on visible it reconnects
 *   and `onResume` lets the consumer refetch to reconcile what it missed.
 * - Same-origin, so the session cookie is sent; the browser replays `Last-Event-ID` on reconnects.
 *
 * The transport is injectable (`liveTransport`) because jsdom has no EventSource; tests use
 * `createFakeEventSource()`.
 */
export type LiveStatus = 'connecting' | 'open' | 'degraded' | 'paused' | 'closed';

export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((e: Event) => void) | null;
  onerror: ((e: Event) => void) | null;
  addEventListener(type: string, listener: (e: MessageEvent) => void): void;
  removeEventListener(type: string, listener: (e: MessageEvent) => void): void;
  close(): void;
}

export interface LiveTransport {
  /** null when the platform has no EventSource (the channel then reports `degraded` at once). */
  create: ((url: string) => EventSourceLike) | null;
}

export const liveTransport: LiveTransport = {
  create: typeof EventSource === 'function' ? (url) => new EventSource(url) : null,
};

export interface LiveChannelOptions {
  events: readonly string[];
  onEvent: (type: string, data: unknown, lastEventId: string) => void;
  onStatus?: (status: LiveStatus) => void;
  /** visible again after a pause: refetch to reconcile */
  onResume?: () => void;
  maxErrors?: number;
  retryMs?: number;
  hiddenPauseMs?: number;
}

export interface LiveChannel {
  status(): LiveStatus;
  close(): void;
}

const CLOSED = 2;

export function createLiveChannel(url: string, opts: LiveChannelOptions, transport: LiveTransport = liveTransport): LiveChannel {
  const maxErrors = opts.maxErrors ?? 3;
  const retryMs = opts.retryMs ?? 15_000;
  const hiddenPauseMs = opts.hiddenPauseMs ?? 60_000;
  let status: LiveStatus = 'connecting';
  let es: EventSourceLike | null = null;
  let errors = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const setStatus = (s: LiveStatus) => {
    if (s === status) return;
    status = s;
    opts.onStatus?.(s);
  };

  const listeners = opts.events.map((type) => {
    const fn = (e: MessageEvent) => {
      let data: unknown;
      try {
        data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
      } catch {
        return; // malformed frame: ignore, the next poll reconciles
      }
      opts.onEvent(type, data, e.lastEventId ?? '');
    };
    return { type, fn };
  });

  function teardown() {
    if (!es) return;
    for (const l of listeners) es.removeEventListener(l.type, l.fn);
    es.onopen = null;
    es.onerror = null;
    es.close();
    es = null;
  }

  function connect() {
    if (disposed) return;
    if (!transport.create) {
      setStatus('degraded');
      return;
    }
    teardown();
    const source = transport.create(url);
    es = source;
    for (const l of listeners) source.addEventListener(l.type, l.fn);
    source.onopen = () => {
      errors = 0;
      setStatus('open');
    };
    source.onerror = () => {
      errors += 1;
      if (errors >= maxErrors) setStatus('degraded');
      else if (status === 'open') setStatus('connecting');
      if (source.readyState === CLOSED) {
        teardown();
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          retryTimer = null;
          connect();
        }, retryMs);
      }
    };
  }

  function onVisibility() {
    if (typeof document === 'undefined') return;
    if (document.hidden) {
      if (hiddenTimer) clearTimeout(hiddenTimer);
      hiddenTimer = setTimeout(() => {
        hiddenTimer = null;
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = null;
        teardown();
        setStatus('paused');
      }, hiddenPauseMs);
      return;
    }
    if (hiddenTimer) {
      clearTimeout(hiddenTimer);
      hiddenTimer = null;
    }
    if (status === 'paused') {
      errors = 0;
      setStatus('connecting');
      connect();
      opts.onResume?.();
    }
  }

  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  opts.onStatus?.(status);
  connect();

  return {
    status: () => status,
    close() {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (hiddenTimer) clearTimeout(hiddenTimer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
      teardown();
      setStatus('closed');
    },
  };
}

/* ------------------------------------------------------------------ test double */

export interface FakeEventSource extends EventSourceLike {
  url: string;
  closed: boolean;
  open(): void;
  error(opts?: { closed?: boolean }): void;
  emit(type: string, data: unknown, id?: string): void;
}

/** A controllable EventSource for unit tests (jsdom has none). */
export function createFakeTransport(): LiveTransport & { sources: FakeEventSource[]; last(): FakeEventSource } {
  const sources: FakeEventSource[] = [];
  return {
    sources,
    last: () => {
      const s = sources[sources.length - 1];
      if (!s) throw new Error('no EventSource created');
      return s;
    },
    create(url: string) {
      const map = new Map<string, Set<(e: MessageEvent) => void>>();
      let readyState = 0;
      const src: FakeEventSource = {
        url,
        closed: false,
        get readyState() {
          return readyState;
        },
        onopen: null,
        onerror: null,
        addEventListener(type, fn) {
          if (!map.has(type)) map.set(type, new Set());
          map.get(type)!.add(fn);
        },
        removeEventListener(type, fn) {
          map.get(type)?.delete(fn);
        },
        close() {
          readyState = CLOSED;
          src.closed = true;
        },
        open() {
          readyState = 1;
          src.onopen?.(new Event('open'));
        },
        error({ closed = false } = {}) {
          readyState = closed ? CLOSED : 0;
          src.onerror?.(new Event('error'));
        },
        emit(type, data, id = '') {
          const e = new MessageEvent(type, { data: typeof data === 'string' ? data : JSON.stringify(data), lastEventId: id });
          for (const fn of map.get(type) ?? []) fn(e);
        },
      };
      sources.push(src);
      return src;
    },
  };
}
