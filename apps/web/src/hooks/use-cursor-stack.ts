import { useCallback, useState } from 'react';

/**
 * Cursor-stack pagination for admin tables (frontend §6.3): Prev pops, Next pushes the page's
 * `nextCursor`. Filters live in the URL; pass them as `resetKey` so a filter change resets the stack.
 */
export function useCursorStack(resetKey: string) {
  const [state, setState] = useState<{ key: string; stack: (string | null)[] }>({ key: resetKey, stack: [null] });
  const stack = state.key === resetKey ? state.stack : [null];
  if (state.key !== resetKey) setState({ key: resetKey, stack: [null] });
  const cursor = stack[stack.length - 1] ?? null;
  const next = useCallback(
    (nextCursor: string | null | undefined) => {
      if (!nextCursor) return;
      setState((s) => ({ key: resetKey, stack: [...(s.key === resetKey ? s.stack : [null]), nextCursor] }));
    },
    [resetKey],
  );
  const prev = useCallback(() => setState((s) => ({ key: resetKey, stack: s.stack.length > 1 ? s.stack.slice(0, -1) : s.stack })), [resetKey]);
  const reset = useCallback(() => setState({ key: resetKey, stack: [null] }), [resetKey]);
  return { cursor, page: stack.length, hasPrev: stack.length > 1, next, prev, reset };
}
