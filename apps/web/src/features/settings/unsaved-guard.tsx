import { useBlocker } from '@tanstack/react-router';

/** Dirty-form guard (§5.2 settings): confirm before leaving the page with unsaved changes. */
export function useUnsavedGuard(dirty: boolean): void {
  useBlocker({
    shouldBlockFn: () => dirty && !window.confirm('You have unsaved changes. Leave anyway?'),
    enableBeforeUnload: () => dirty,
  });
}

export function UnsavedHint({ dirty }: { dirty: boolean }) {
  return dirty ? <span className="text-[13px] text-warning">Unsaved changes</span> : null;
}
