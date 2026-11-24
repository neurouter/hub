import * as z from 'zod';
import { HealthStatus, OAuthClientIdMode, ServerAuthType, ServerEra, ServerStatus, ServerTransport, SyncRunStatus, SyncTrigger } from '../domain/enums.js';
import { SLUG_REGEX } from '../mcp/naming.js';
import { Actions, CursorQuery, Id, IdParams, IsoDateTime, IsoDateTimeInput, JobAccepted, Page, Ref, queryOptional, sortParam } from './common.js';
import { endpoint } from './endpoint.js';

export const Health = z.object({
  status: HealthStatus,
  latencyMs: z.number().int().nonnegative().nullable(),
  checkedAt: IsoDateTime.nullable(),
});
export type Health = z.infer<typeof Health>;

const HeaderName = z.string().trim().min(1).max(100).regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, 'Invalid HTTP header name');
const Secret = z.string().min(1).max(8192);

export const ServerOAuthIn = z.object({
  discovery: z.enum(['auto', 'manual']),
  authorizationServerUrl: z.url().optional(),
  /** Omitted → gateway CIMD if the AS supports it, else DCR. */
  clientId: z.string().min(1).max(500).optional(),
  clientSecret: Secret.optional(),
  scopes: z.array(z.string().min(1).max(200)).max(50),
});
export type ServerOAuthIn = z.infer<typeof ServerOAuthIn>;

/** Write-side upstream auth (discriminated on `type`). Secrets are write-only. */
export const ServerAuthIn = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('shared_bearer'), token: Secret }),
  z.object({ type: z.literal('shared_header'), headerName: HeaderName, headerValue: Secret }),
  z.object({ type: z.literal('per_user_oauth'), oauth: ServerOAuthIn }),
]);
export type ServerAuthIn = z.infer<typeof ServerAuthIn>;

/** Same as ServerAuthIn but secrets optional (test-connection / PATCH may reuse the stored secret). */
export const ServerAuthInPartialSecret = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('shared_bearer'), token: Secret.optional() }),
  z.object({ type: z.literal('shared_header'), headerName: HeaderName, headerValue: Secret.optional() }),
  z.object({ type: z.literal('per_user_oauth'), oauth: ServerOAuthIn }),
]);
export type ServerAuthInPartialSecret = z.infer<typeof ServerAuthInPartialSecret>;

/** Read-side upstream auth: never contains secrets. */
export const ServerAuthOut = z.object({
  type: ServerAuthType,
  hasSecret: z.boolean(),
  secretUpdatedAt: IsoDateTime.nullable(),
  headerName: z.string().optional(),
  oauth: z
    .object({
      clientId: z.string().nullable(),
      clientIdMode: OAuthClientIdMode,
      scopes: z.array(z.string()),
      callbackUrl: z.string(),
    })
    .optional(),
});
export type ServerAuthOut = z.infer<typeof ServerAuthOut>;

export const ServerRow = z.object({
  id: Id,
  slug: z.string(),
  name: z.string(),
  url: z.string(),
  transport: ServerTransport,
  authType: ServerAuthType,
  owner: Ref,
  trusted: z.boolean(),
  enabled: z.boolean(),
  status: ServerStatus.optional(),
  health: Health,
  toolCount: z.number().int().nonnegative(),
  enabledToolCount: z.number().int().nonnegative(),
  pendingReviewCount: z.number().int().nonnegative(),
  lastSyncAt: IsoDateTime.nullable(),
  /** Always the same-origin `/api/servers/:id/icon`, or null. Never a remote URL. */
  iconUrl: z.string().nullable(),
});
export type ServerRow = z.infer<typeof ServerRow>;

export const ServerRateLimit = z.object({ perToolPerMinute: z.number().int().positive().nullable() });

export const ServerDetail = ServerRow.extend({
  description: z.string(),
  tags: z.array(z.string()),
  auth: ServerAuthOut,
  timeoutMs: z.number().int().positive(),
  syncIntervalMin: z.number().int().positive().nullable(),
  autoApproveNewTools: z.boolean(),
  rateLimit: ServerRateLimit.nullable(),
  detectedEra: ServerEra.nullable(),
  protocolVersion: z.string().nullable(),
  serverInfo: z.object({ name: z.string(), version: z.string() }).nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  actions: Actions,
});
export type ServerDetail = z.infer<typeof ServerDetail>;

export const SERVER_SORT_FIELDS = ['name', 'createdAt', 'health'] as const;
export const ListServersQuery = CursorQuery.extend({
  q: queryOptional(z.string().max(200)),
  status: queryOptional(ServerStatus),
  ownerId: queryOptional(Id),
  sort: sortParam(SERVER_SORT_FIELDS),
  order: queryOptional(z.enum(['asc', 'desc'])),
});
export type ListServersQuery = z.infer<typeof ListServersQuery>;

export const Slug = z.string().regex(SLUG_REGEX, 'Use 1–32 lowercase letters, digits and single hyphens (no underscores)');
const Tag = z.string().trim().min(1).max(50);
/** Admin-set icon source: https or data: URL (spec icon rules). */
export const IconSourceUrl = z.string().max(300_000).refine((v) => v.startsWith('https://') || v.startsWith('data:image/'), 'Icon must be an https or data:image URL');
const TimeoutMs = z.number().int().min(1000).max(600_000);
const SyncIntervalMin = z.number().int().min(1).max(10_080);

export const CreateServerBody = z.object({
  name: z.string().trim().min(1).max(100),
  slug: Slug,
  description: z.string().max(2000).optional(),
  tags: z.array(Tag).max(20).default([]),
  iconUrl: IconSourceUrl.optional(),
  ownerId: Id,
  url: z.url(),
  transport: ServerTransport,
  trusted: z.boolean().default(false),
  auth: ServerAuthIn,
  timeoutMs: TimeoutMs.optional(),
  syncIntervalMin: SyncIntervalMin.optional(),
  autoApproveNewTools: z.boolean().optional(),
});
export type CreateServerBody = z.input<typeof CreateServerBody>;

export const CreateServerResponse = ServerDetail.extend({ initialSync: z.object({ jobId: Id }) });
export type CreateServerResponse = z.infer<typeof CreateServerResponse>;

/** Owners may change the first group of fields; admins also url/transport/trusted/ownerId/auth type/slug (backend §14.3). */
export const UpdateServerBody = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().max(2000).optional(),
  tags: z.array(Tag).max(20).optional(),
  iconUrl: IconSourceUrl.nullable().optional(),
  enabled: z.boolean().optional(),
  timeoutMs: TimeoutMs.optional(),
  syncIntervalMin: SyncIntervalMin.nullable().optional(),
  rateLimit: ServerRateLimit.nullable().optional(),
  autoApproveNewTools: z.boolean().optional(),
  // admin-only
  url: z.url().optional(),
  transport: ServerTransport.optional(),
  trusted: z.boolean().optional(),
  ownerId: Id.optional(),
  slug: Slug.optional(),
  auth: ServerAuthInPartialSecret.optional(),
});
export type UpdateServerBody = z.infer<typeof UpdateServerBody>;

export const TestConnectionBody = z.object({
  url: z.url(),
  transport: ServerTransport,
  auth: ServerAuthInPartialSecret,
  /** Use the stored secret of this server when `auth` omits it. */
  serverId: Id.optional(),
});
export type TestConnectionBody = z.infer<typeof TestConnectionBody>;

export const TestConnectionResult = z.object({
  ok: z.boolean(),
  protocolVersion: z.string().nullable(),
  era: ServerEra.nullable(),
  serverInfo: z.object({ name: z.string(), version: z.string() }).nullable(),
  toolCount: z.number().int().nonnegative().nullable(),
  latencyMs: z.number().int().nonnegative(),
  authRequired: z.boolean(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type TestConnectionResult = z.infer<typeof TestConnectionResult>;

/** Write-only secret replacement. */
export const PutCredentialsBody = z.union([
  z.object({ token: Secret }),
  z.object({ headerValue: Secret }),
  z.object({ oauth: z.object({ clientSecret: Secret }) }),
]);
export type PutCredentialsBody = z.infer<typeof PutCredentialsBody>;
export const CredentialsStatus = z.object({ hasSecret: z.boolean(), secretUpdatedAt: IsoDateTime.nullable() });
export type CredentialsStatus = z.infer<typeof CredentialsStatus>;

export const IconRefreshResult = z.object({ ok: z.boolean(), error: z.string().nullable() });

export const SyncRun = z.object({
  id: Id,
  trigger: SyncTrigger,
  status: SyncRunStatus,
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime.nullable(),
  added: z.number().int(),
  changed: z.number().int(),
  removed: z.number().int(),
  unchanged: z.number().int(),
  error: z.string().nullable(),
});
export type SyncRun = z.infer<typeof SyncRun>;

export const HealthHistoryQuery = z.object({ from: queryOptional(IsoDateTimeInput), to: queryOptional(IsoDateTimeInput) });
export const HealthHistory = z.object({
  points: z.array(z.object({ t: IsoDateTime, status: HealthStatus, latencyMs: z.number().int().nonnegative().nullable() })),
});
export type HealthHistory = z.infer<typeof HealthHistory>;

export const serverEndpoints = {
  list: endpoint({
    method: 'GET', path: '/api/servers', kind: 'json', access: ['owner', 'auditor'],
    summary: 'List servers (owners: owned only)', query: ListServersQuery, response: Page(ServerRow),
  }),
  testConnection: endpoint({
    method: 'POST', path: '/api/servers/test-connection', kind: 'json', access: ['admin', 'owner'],
    summary: 'Dry-run connect to an upstream', body: TestConnectionBody, response: TestConnectionResult,
  }),
  create: endpoint({
    method: 'POST', path: '/api/servers', kind: 'json', status: 201, access: ['admin'],
    summary: 'Register an upstream server', body: CreateServerBody, response: CreateServerResponse,
  }),
  get: endpoint({
    method: 'GET', path: '/api/servers/:id', kind: 'json', access: ['owner', 'auditor'],
    summary: 'Server detail', params: IdParams, response: ServerDetail,
  }),
  update: endpoint({
    method: 'PATCH', path: '/api/servers/:id', kind: 'json', access: ['owner', 'admin'],
    summary: 'Edit a server (no secrets)', params: IdParams, body: UpdateServerBody, response: ServerDetail,
  }),
  delete: endpoint({
    method: 'DELETE', path: '/api/servers/:id', kind: 'empty', access: ['admin'],
    summary: 'Soft delete: disabled, tools blocked, audit kept', params: IdParams,
  }),
  putCredentials: endpoint({
    method: 'PUT', path: '/api/servers/:id/credentials', kind: 'json', access: ['admin'],
    summary: 'Replace upstream secrets (write-only)', params: IdParams, body: PutCredentialsBody, response: CredentialsStatus,
  }),
  icon: endpoint({
    method: 'GET', path: '/api/servers/:id/icon', kind: 'binary', access: ['user'],
    summary: 'Proxied server icon (404 when none)', params: IdParams,
  }),
  refreshIcon: endpoint({
    method: 'POST', path: '/api/servers/:id/icon/refresh', kind: 'json', access: ['owner'],
    summary: 'Re-fetch the server icon', params: IdParams, response: IconRefreshResult,
  }),
  sync: endpoint({
    method: 'POST', path: '/api/servers/:id/sync', kind: 'json', status: 202, access: ['owner'],
    summary: 'Sync tools now (poll /api/jobs/:id)', params: IdParams, response: JobAccepted,
  }),
  syncRuns: endpoint({
    method: 'GET', path: '/api/servers/:id/sync-runs', kind: 'json', access: ['owner', 'auditor'],
    summary: 'Tool sync history', params: IdParams, query: CursorQuery, response: Page(SyncRun),
  }),
  healthCheck: endpoint({
    method: 'POST', path: '/api/servers/:id/health-check', kind: 'json', access: ['owner'],
    summary: 'Run a health check now', params: IdParams, response: Health,
  }),
  health: endpoint({
    method: 'GET', path: '/api/servers/:id/health', kind: 'json', access: ['owner', 'auditor'],
    summary: 'Health history', params: IdParams, query: HealthHistoryQuery, response: HealthHistory,
  }),
} as const;
