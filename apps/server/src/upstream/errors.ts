/** Upstream failure classes (backend §5.6 error semantics). */
export type UpstreamErrorKind = 'transport' | 'timeout' | 'auth_required' | 'circuit_open' | 'protocol' | 'cancelled' | 'connect_required';

export class UpstreamError extends Error {
  constructor(
    readonly kind: UpstreamErrorKind,
    message: string,
    readonly details: { status?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

/** Maps SDK / fetch errors to an UpstreamError (never leaks secrets: messages only). */
export function classifyUpstreamError(err: unknown, signal?: AbortSignal): UpstreamError {
  if (err instanceof UpstreamError) return err;
  const e = err as { name?: string; code?: unknown; message?: string; data?: { status?: number } } | undefined;
  const msg = e?.message ?? String(err);
  if (signal?.aborted) {
    const reason = signal.reason as { name?: string } | undefined;
    if (reason?.name === 'TimeoutError') return new UpstreamError('timeout', 'Upstream request timed out', { cause: err });
    return new UpstreamError('cancelled', 'Request cancelled', { cause: err });
  }
  if (e?.code === 'REQUEST_TIMEOUT' || e?.name === 'TimeoutError') return new UpstreamError('timeout', 'Upstream request timed out', { cause: err });
  const status = typeof e?.data?.status === 'number' ? e.data.status : /\b(401|403)\b/.exec(msg) ? Number(/\b(401|403)\b/.exec(msg)![1]) : undefined;
  if (status === 401 || e?.name === 'UnauthorizedError') return new UpstreamError('auth_required', 'Upstream rejected the credentials (401)', { status: 401, cause: err });
  if (typeof e?.code === 'number') return new UpstreamError('protocol', msg, { cause: err });
  return new UpstreamError('transport', msg.slice(0, 300), { ...(status ? { status } : {}), cause: err });
}
