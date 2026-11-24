import { toast } from '@/components/ui/toast';
import { ApiError, ApiContractError } from './api-client';

/** Success toast (polite). */
export function notifySuccess(title: string, description?: string): void {
  toast.add({ title, ...(description ? { description } : {}), type: 'success' });
}

/** Human message for an API error (problem `detail`, or the title, or a generic fallback). */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429 && err.retryAfterSec) return `Rate limited, retry in ${err.retryAfterSec} s`;
    return err.detail ?? err.title;
  }
  if (err instanceof ApiContractError) return 'The server returned an unexpected response.';
  return err instanceof Error ? err.message : 'Something went wrong';
}

/**
 * Error toast for a failed mutation. 401/403 are handled globally by the QueryClient
 * (redirect / permission toast), so they are skipped here to avoid a double toast.
 */
export function notifyError(err: unknown, title = 'Something went wrong'): void {
  if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return;
  toast.add({ title, description: errorMessage(err), type: 'error' });
}
