import type * as z from 'zod';
import {
  PROBLEM_CONTENT_TYPE,
  Problem,
  buildPath,
  serializeQuery,
  type EndpointDef,
  type ProblemFieldError,
  type QueryValue,
} from '@neurouter/shared';

/** Error thrown for every non-2xx response (RFC 9457 problem+json, or a synthetic one). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail: string | undefined;
  readonly requestId: string | undefined;
  readonly fieldErrors: ProblemFieldError[];
  readonly retryAfterSec: number | undefined;

  constructor(init: { status: number; code: string; title: string; detail?: string; requestId?: string; fieldErrors?: ProblemFieldError[]; retryAfterSec?: number }) {
    super(init.detail ?? init.title);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.title = init.title;
    this.detail = init.detail;
    this.requestId = init.requestId;
    this.fieldErrors = init.fieldErrors ?? [];
    this.retryAfterSec = init.retryAfterSec;
  }
}

/** The response did not match the shared contract (drift between web and server). */
export class ApiContractError extends Error {
  constructor(
    readonly endpoint: string,
    readonly issues: z.core.$ZodIssue[],
    readonly requestId: string | undefined,
  ) {
    super(`Response from ${endpoint} does not match the API contract`);
    this.name = 'ApiContractError';
  }
}

let csrfToken: string | null = null;
/** Set from `/api/me.csrfToken`; sent as X-CSRF-Token on every non-GET request. */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}
export function getCsrfToken(): string | null {
  return csrfToken;
}

export interface ApiRequestOptions {
  params?: Record<string, string | number>;
  query?: Record<string, QueryValue>;
  body?: unknown;
  signal?: AbortSignal;
  /** injectable for tests */
  fetchImpl?: typeof fetch;
}

async function toApiError(res: Response): Promise<ApiError> {
  const requestId = res.headers.get('x-request-id') ?? undefined;
  const retryAfter = res.headers.get('retry-after');
  const retryAfterSec = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined;
  const type = res.headers.get('content-type') ?? '';
  if (type.includes(PROBLEM_CONTENT_TYPE) || type.includes('application/json')) {
    try {
      const parsed = Problem.safeParse(await res.json());
      if (parsed.success) {
        const p = parsed.data;
        return new ApiError({
          status: p.status,
          code: p.code,
          title: p.title,
          ...(p.detail !== undefined ? { detail: p.detail } : {}),
          requestId: p.requestId,
          fieldErrors: p.errors ?? [],
          ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
        });
      }
    } catch {
      // fall through to the synthetic error
    }
  }
  const code = res.status === 502 || res.status === 503 || res.status === 504 ? 'bad_gateway' : res.status >= 500 ? 'internal' : 'http_error';
  return new ApiError({
    status: res.status,
    code,
    title: res.statusText || 'Request failed',
    ...(requestId ? { requestId } : {}),
    ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
  });
}

/**
 * Calls an endpoint from the shared contract. Same-origin only (no host anywhere in code),
 * JSON in/out, CSRF header on mutations, and the response parsed with the contract schema.
 */
export async function apiFetch<D extends EndpointDef>(def: D, opts: ApiRequestOptions = {}): Promise<D['response'] extends z.ZodType ? z.infer<D['response']> : void> {
  const url = buildPath(def.path, opts.params) + serializeQuery(opts.query);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (def.method !== 'GET') {
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
  }
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, { method: def.method, headers, body, credentials: 'same-origin', signal: opts.signal ?? null });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new ApiError({ status: 0, code: 'network', title: 'Network error', detail: 'Could not reach the server' });
  }
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204 || def.kind === 'empty' || !def.response) return undefined as never;
  const json: unknown = await res.json();
  const parsed = (def.response as z.ZodType).safeParse(json);
  if (!parsed.success) {
    const err = new ApiContractError(`${def.method} ${def.path}`, parsed.error.issues, res.headers.get('x-request-id') ?? undefined);
    if (import.meta.env.DEV) console.error(err, parsed.error.issues);
    throw err;
  }
  return parsed.data as never;
}

/** Maps server field errors onto react-hook-form (`setError(path.join('.'))`). Returns how many were applied. */
export function applyServerErrors(form: { setError: (...args: never[]) => void }, err: unknown): number {
  if (!(err instanceof ApiError)) return 0;
  const setError = form.setError as unknown as (name: string, error: { type: string; message: string }) => void;
  for (const fe of err.fieldErrors) setError(fe.path.join('.'), { type: 'server', message: fe.message });
  return err.fieldErrors.length;
}
