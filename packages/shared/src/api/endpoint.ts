import type * as z from 'zod';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * How the endpoint responds:
 * - `json`: JSON body validated by `response`
 * - `empty`: 204 No Content
 * - `navigation`: browser navigation that answers with a 302 (never fetched by the SPA)
 * - `sse`: `text/event-stream`
 * - `download`: streamed attachment (CSV / NDJSON)
 * - `binary`: raw bytes (icons)
 */
export type EndpointKind = 'json' | 'empty' | 'navigation' | 'sse' | 'download' | 'binary';

/** "Role" column values from backend §14.1. */
export type AccessLevel = 'public' | 'user' | 'self' | 'owner' | 'auditor' | 'admin';

export interface EndpointDef {
  method: HttpMethod;
  /** Express/Fastify style path with `:param` segments, including the `/api` prefix. */
  path: string;
  kind: EndpointKind;
  /** Success status (200 unless stated). */
  status: number;
  access: readonly AccessLevel[];
  summary: string;
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  response?: z.ZodType;
}

export function endpoint<const D extends Omit<EndpointDef, 'status'> & { status?: number }>(def: D): D & { status: number } {
  return { status: def.kind === 'empty' ? 204 : 200, ...def } as D & { status: number };
}

type Shape<D, K extends string> = D extends Record<K, infer S> ? (S extends z.ZodType ? z.infer<S> : never) : undefined;
export type EndpointParams<D> = Shape<D, 'params'>;
export type EndpointQuery<D> = Shape<D, 'query'>;
export type EndpointBody<D> = Shape<D, 'body'>;
export type EndpointResponse<D> = Shape<D, 'response'>;

/** Names of the `:param` segments of a path, in order. */
export function pathParamNames(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1] as string);
}

/** Fills `:param` segments (URI-encoded). Throws on a missing param. */
export function buildPath(path: string, params: Record<string, string | number> = {}): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, (_, name: string) => {
    const v = params[name];
    if (v === undefined || v === '') throw new Error(`Missing path param "${name}" for ${path}`);
    return encodeURIComponent(String(v));
  });
}

export type QueryValue = string | number | boolean | Date | null | undefined | readonly (string | number | boolean | Date)[];

/**
 * Serializes a query object the way the API expects (backend §14.1): arrays as repeated keys,
 * dates as ISO-8601, empty / null / undefined values dropped. Keys are emitted in insertion order.
 */
export function serializeQuery(query: Record<string, QueryValue> | undefined): string {
  if (!query) return '';
  const parts: string[] = [];
  const add = (k: string, v: string | number | boolean | Date) => {
    const s = v instanceof Date ? v.toISOString() : String(v);
    if (s !== '') parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(s)}`);
  };
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const item of v as readonly (string | number | boolean | Date)[]) add(k, item);
    else add(k, v as string | number | boolean | Date);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}
