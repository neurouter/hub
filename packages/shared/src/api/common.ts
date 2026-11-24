import * as z from 'zod';

/* ------------------------------------------------------------------ primitives */

/** ISO-8601 UTC timestamp in responses (e.g. `2026-11-24T10:00:00.000Z`). */
export const IsoDateTime = z.iso.datetime();
export type IsoDateTime = z.infer<typeof IsoDateTime>;

/** ISO-8601 timestamp accepted in requests/query strings (offsets allowed, server normalizes to UTC). */
export const IsoDateTimeInput = z.iso.datetime({ offset: true });

/** Opaque id (UUIDv7 string). Kept loose so fixtures and legacy ids still parse; the server generates UUIDv7. */
export const Id = z.string().min(1).max(128);
export type Id = z.infer<typeof Id>;

export const Ref = z.object({ id: Id, name: z.string() });
export type Ref = z.infer<typeof Ref>;

export const ServerRef = Ref.extend({ slug: z.string() });
export type ServerRef = z.infer<typeof ServerRef>;

export const UserRefWithEmail = Ref.extend({ email: z.string() });
export type UserRefWithEmail = z.infer<typeof UserRefWithEmail>;

export const IdParams = z.object({ id: Id });
export type IdParams = z.infer<typeof IdParams>;

export const SortOrder = z.enum(['asc', 'desc']);
export type SortOrder = z.infer<typeof SortOrder>;

export const JsonObject = z.record(z.string(), z.unknown());
export type JsonObject = z.infer<typeof JsonObject>;

/** `{ "$redacted": "<rule-name>" }` marker the audit redactor leaves in place of a value. */
export const RedactedMarker = z.object({ $redacted: z.string() });
export type RedactedMarker = z.infer<typeof RedactedMarker>;
export function isRedactedMarker(v: unknown): v is RedactedMarker {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 1 && typeof (v as Record<string, unknown>).$redacted === 'string';
}

/* ------------------------------------------------------------------ query helpers */

/** A repeated query key (`a=1&a=2`) arrives as string | string[]; normalize to an array. */
export function queryArray<T extends z.ZodType>(item: T) {
  return z.preprocess((v) => (v === undefined || v === '' ? undefined : Array.isArray(v) ? v : [v]), z.array(item).optional());
}

/** `true` / `false` (also `1` / `0`) in a query string. */
export const QueryBool = z.preprocess((v) => {
  if (v === 'true' || v === '1' || v === true) return true;
  if (v === 'false' || v === '0' || v === false) return false;
  return v;
}, z.boolean());

/** Drops empty strings (the API ignores empty query values). */
export function queryOptional<T extends z.ZodType>(schema: T) {
  return z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
}

/* ------------------------------------------------------------------ pagination */

export const PAGE_LIMIT_DEFAULT = 50;
export const PAGE_LIMIT_MAX = 200;

export const CursorQuery = z.object({
  cursor: queryOptional(z.string().max(2048)),
  limit: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).optional()),
});
export type CursorQuery = z.infer<typeof CursorQuery>;

/** `Page<T> = { items, nextCursor, totalEstimate? }` (backend §14.1). */
export function Page<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    totalEstimate: z.number().int().nonnegative().optional(),
  });
}
export type Page<T> = { items: T[]; nextCursor: string | null; totalEstimate?: number };

export function Items<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item) });
}

/** Sort param from a per-endpoint allowlist. */
export function sortParam<const F extends readonly [string, ...string[]]>(fields: F) {
  return queryOptional(z.enum(fields));
}

/* ------------------------------------------------------------------ errors (RFC 9457) */

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
export const PROBLEM_TYPE_BASE = 'https://neurouter.dev/problems/';

/** Error codes, statuses and titles (backend §14.1). `type` URIs are stable per code. */
export const PROBLEM_CODES = {
  bad_request: { status: 400, title: 'Bad request' },
  unauthenticated: { status: 401, title: 'Authentication required' },
  forbidden: { status: 403, title: 'Forbidden' },
  not_found: { status: 404, title: 'Not found' },
  method_not_allowed: { status: 405, title: 'Method not allowed' },
  conflict: { status: 409, title: 'Conflict' },
  gone: { status: 410, title: 'Gone' },
  precondition_failed: { status: 412, title: 'Precondition failed' },
  payload_too_large: { status: 413, title: 'Payload too large' },
  unsupported_media_type: { status: 415, title: 'Unsupported media type' },
  validation_failed: { status: 422, title: 'Validation failed' },
  rate_limited: { status: 429, title: 'Too many requests' },
  internal: { status: 500, title: 'Internal server error' },
  upstream_unavailable: { status: 502, title: 'Upstream unavailable' },
  service_unavailable: { status: 503, title: 'Service unavailable' },
} as const satisfies Record<string, { status: number; title: string }>;

export type ProblemCode = keyof typeof PROBLEM_CODES;
export const ProblemCodeSchema = z.enum(Object.keys(PROBLEM_CODES) as [ProblemCode, ...ProblemCode[]]);

export function problemType(code: string): string {
  return PROBLEM_TYPE_BASE + code.replaceAll('_', '-');
}

export const ProblemFieldError = z.object({
  path: z.array(z.string()),
  message: z.string(),
  code: z.string(),
});
export type ProblemFieldError = z.infer<typeof ProblemFieldError>;

/** RFC 9457 problem details + Neurouter extensions (`code`, `requestId`, `errors`). `code` is open for forward compat. */
export const Problem = z.looseObject({
  type: z.string(),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  detail: z.string().optional(),
  instance: z.string().optional(),
  code: z.string(),
  requestId: z.string(),
  errors: z.array(ProblemFieldError).optional(),
});
export type Problem = z.infer<typeof Problem>;

/** Converts a zod error path to the problem `errors[].path` form (strings only). */
export function toProblemPath(path: readonly PropertyKey[]): string[] {
  return path.map((p) => String(p));
}

/* ------------------------------------------------------------------ misc shapes */

export const ClientInfo = z.object({ name: z.string(), version: z.string().nullable() });
export type ClientInfo = z.infer<typeof ClientInfo>;

export const ToolNameRef = z.object({ name: z.string(), qualifiedName: z.string() });
export type ToolNameRef = z.infer<typeof ToolNameRef>;

export const JobAccepted = z.object({ jobId: Id });
export type JobAccepted = z.infer<typeof JobAccepted>;

/** Per-resource allowed mutations (frontend A4). */
export const Actions = z.array(z.string());

export const TimeRangeQuery = z.object({
  from: queryOptional(IsoDateTimeInput),
  to: queryOptional(IsoDateTimeInput),
});

/** Required, bounded time range (backend addendum 4: audit queries must send one). */
export const RequiredTimeRangeQuery = z.object({ from: IsoDateTimeInput, to: IsoDateTimeInput });

export const DEFAULT_AUDIT_MAX_RANGE_DAYS = 31;

export function timeRangeIssue(from: string, to: string, maxDays = DEFAULT_AUDIT_MAX_RANGE_DAYS): string | null {
  const f = Date.parse(from);
  const t = Date.parse(to);
  if (Number.isNaN(f) || Number.isNaN(t)) return 'from and to must be ISO-8601 timestamps';
  if (t <= f) return '`to` must be after `from`';
  if (t - f > maxDays * 86_400_000) return `time range must not exceed ${maxDays} days`;
  return null;
}
