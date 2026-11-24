import type { Json, Unsubscribe, WaitForOptions } from './types.js';

/** Shared `waitFor` over any subscribe function: signal, poll fallback, timeout, abort. */
export function waitForOn(subscribe: (fn: (p: Json) => void) => Unsubscribe, predicate: (p: Json) => boolean, opts: WaitForOptions): Promise<Json | null> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(opts.signal.reason ?? new Error('aborted'));
    let done = false;
    const timers: NodeJS.Timeout[] = [];
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      unsubscribe();
      for (const t of timers) {
        clearTimeout(t);
        clearInterval(t);
      }
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => finish(() => reject(opts.signal?.reason ?? new Error('aborted')));
    const unsubscribe = subscribe((p) => {
      if (predicate(p)) finish(() => resolve(p));
    });
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    timers.push(setTimeout(() => finish(() => resolve(null)), opts.timeoutMs));
    if (opts.poll) {
      const poll = opts.poll;
      timers.push(
        setInterval(() => {
          poll().then(
            (p) => {
              if (p !== null && predicate(p)) finish(() => resolve(p));
            },
            () => {},
          );
        }, opts.pollEveryMs ?? 2000),
      );
    }
  });
}
