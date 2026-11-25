import * as z from 'zod';
import { ServerTransport } from '../domain/enums.js';
import { CursorQuery, Id, IdParams, IsoDateTime, Page, QueryBool, queryOptional } from './common.js';
import { endpoint } from './endpoint.js';

/*
 * MCP server library: a local copy of an MCP registry (the official one by default) with search
 * and a deterministic quality grade. Grades are computed by code from observable signals (registry
 * metadata, a connection check, tool-definition lint, GitHub data, and for servers already in the
 * gateway our own health and usage data); no model is involved, and every point is explained.
 */

export const LetterGrade = z.enum(['A', 'B', 'C', 'D', 'F']);
export type LetterGrade = z.infer<typeof LetterGrade>;

export const GradeConfidence = z.enum(['low', 'medium', 'high']);
export type GradeConfidence = z.infer<typeof GradeConfidence>;

/**
 * Publisher trust, shown next to (never averaged into) the grade:
 * - `verified`: a domain namespace whose endpoint is on that domain, or a GitHub organization namespace that owns the repository
 * - `known`: a GitHub user namespace that owns the repository, or a DNS-verified namespace without a remote
 * - `unverified`: nothing ties the name to the endpoint or the code
 * - `mismatch`: the name claims a domain but the endpoint is on another one
 */
export const PublisherTrust = z.enum(['verified', 'known', 'unverified', 'mismatch']);
export type PublisherTrust = z.infer<typeof PublisherTrust>;

export const GradeSubscoreKey = z.enum(['connectivity', 'definitions', 'maintenance', 'hygiene', 'adoption']);
export type GradeSubscoreKey = z.infer<typeof GradeSubscoreKey>;

export const GradeSignal = z.object({
  label: z.string(),
  /** Human-readable observed value, e.g. "99.4% of 2,016 checks", "412 stars". */
  value: z.string(),
  /** 0–1 contribution inside its sub-score; null for informational rows. */
  score: z.number().min(0).max(1).nullable(),
});
export type GradeSignal = z.infer<typeof GradeSignal>;

export const GradeSubscore = z.object({
  key: GradeSubscoreKey,
  label: z.string(),
  weight: z.number().int().positive(),
  /** 0–1, or null when no data was available (unknown is not zero: it is left out of the grade). */
  score: z.number().min(0).max(1).nullable(),
  signals: z.array(GradeSignal),
});
export type GradeSubscore = z.infer<typeof GradeSubscore>;

export const GradeFlag = z.object({
  code: z.string(),
  severity: z.enum(['info', 'warn', 'danger']),
  message: z.string(),
  /** The best grade this flag allows, if it caps the grade. */
  cap: LetterGrade.nullable(),
});
export type GradeFlag = z.infer<typeof GradeFlag>;

export const QualityGrade = z.object({
  /** Algorithm version; grades of different versions are not comparable. */
  version: z.number().int().positive(),
  /** Null = unrated (no sub-score could be computed). */
  grade: LetterGrade.nullable(),
  score: z.number().min(0).max(1).nullable(),
  /** The grade before caps, when a flag lowered it. */
  uncappedGrade: LetterGrade.nullable(),
  confidence: GradeConfidence,
  trust: PublisherTrust,
  trustReason: z.string(),
  subscores: z.array(GradeSubscore),
  flags: z.array(GradeFlag),
  /** What data the grade used, e.g. ["registry", "check", "github"]. */
  sources: z.array(z.string()),
  computedAt: IsoDateTime,
});
export type QualityGrade = z.infer<typeof QualityGrade>;

export const LibraryEntryStatus = z.enum(['active', 'deprecated', 'deleted']);
export type LibraryEntryStatus = z.infer<typeof LibraryEntryStatus>;

export const LibraryRemote = z.object({
  type: z.enum(['streamable-http', 'sse']),
  url: z.string(),
  headers: z.array(z.object({ name: z.string(), required: z.boolean(), secret: z.boolean(), description: z.string().nullable() })),
  /** URL template variables (`{tenant}`) the admin must fill in. */
  variables: z.array(z.string()),
});
export type LibraryRemote = z.infer<typeof LibraryRemote>;

export const LibraryEntryRow = z.object({
  id: Id,
  /** Registry name, e.g. `io.github.github/github-mcp-server`. */
  name: z.string(),
  title: z.string().nullable(),
  description: z.string(),
  version: z.string(),
  status: LibraryEntryStatus,
  namespace: z.string(),
  hasRemote: z.boolean(),
  hasPackages: z.boolean(),
  transport: ServerTransport.nullable(),
  repositoryUrl: z.string().nullable(),
  websiteUrl: z.string().nullable(),
  grade: LetterGrade.nullable(),
  confidence: GradeConfidence,
  trust: PublisherTrust,
  /** The most severe flag, if any. */
  topFlag: GradeFlag.nullable(),
  hidden: z.boolean(),
  /** A gateway server already uses this entry (imported from it, or the same URL). */
  inGateway: z.object({ id: Id, name: z.string() }).nullable(),
  checkedAt: IsoDateTime.nullable(),
  updatedAt: IsoDateTime,
});
export type LibraryEntryRow = z.infer<typeof LibraryEntryRow>;

export const LibraryCheckTool = z.object({
  name: z.string(),
  score: z.number().min(0).max(1),
  issues: z.array(z.string()),
});
export type LibraryCheckTool = z.infer<typeof LibraryCheckTool>;

/** Result of the last on-demand check (connection without credentials + GitHub lookup). */
export const LibraryCheck = z.object({
  checkedAt: IsoDateTime,
  connection: z.object({
    ok: z.boolean(),
    authRequired: z.boolean(),
    oauthDiscovery: z.boolean(),
    /** HTTP 402: a paid endpoint (e.g. x402). Not counted as down. */
    paymentRequired: z.boolean().default(false),
    protocolVersion: z.string().nullable(),
    serverInfo: z.object({ name: z.string(), version: z.string() }).nullable(),
    latencyMs: z.number().int().nonnegative().nullable(),
    toolCount: z.number().int().nonnegative().nullable(),
    error: z.string().nullable(),
  }).nullable(),
  tools: z.array(LibraryCheckTool),
  github: z.object({
    repo: z.string(),
    found: z.boolean(),
    archived: z.boolean(),
    stars: z.number().int().nonnegative(),
    pushedAt: IsoDateTime.nullable(),
    license: z.string().nullable(),
    ownerType: z.enum(['User', 'Organization']).nullable(),
    error: z.string().nullable(),
  }).nullable(),
});
export type LibraryCheck = z.infer<typeof LibraryCheck>;

/** A `CreateServerBody` pre-fill for "Add to gateway" (the admin still picks the owner and enters secrets). */
export const LibraryServerDraft = z.object({
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  url: z.string(),
  transport: ServerTransport,
  tags: z.array(z.string()),
  auth: z.discriminatedUnion('type', [
    z.object({ type: z.literal('none') }),
    z.object({ type: z.literal('shared_bearer') }),
    z.object({ type: z.literal('shared_header'), headerName: z.string() }),
    z.object({ type: z.literal('per_user_oauth') }),
  ]),
  /** Things the admin must resolve before saving (URL variables, extra headers). */
  notes: z.array(z.string()),
});
export type LibraryServerDraft = z.infer<typeof LibraryServerDraft>;

export const LibraryEntryDetail = LibraryEntryRow.extend({
  remotes: z.array(LibraryRemote),
  packages: z.array(z.object({ registryType: z.string(), identifier: z.string(), transport: z.string() })),
  publishedAt: IsoDateTime.nullable(),
  statusMessage: z.string().nullable(),
  quality: QualityGrade,
  check: LibraryCheck.nullable(),
  /** Null for package-only entries (they need a local runtime this gateway doesn't provide yet). */
  draft: LibraryServerDraft.nullable(),
  serverJson: z.record(z.string(), z.unknown()),
  sourceUrl: z.string(),
});
export type LibraryEntryDetail = z.infer<typeof LibraryEntryDetail>;

export const LIBRARY_SORTS = ['relevance', 'grade', 'name', 'updated'] as const;
export const ListLibraryQuery = CursorQuery.extend({
  q: queryOptional(z.string().max(200)),
  /** Default true: only entries with a remote endpoint (package-only servers need a local runtime). */
  remoteOnly: queryOptional(QueryBool),
  minGrade: queryOptional(LetterGrade),
  trust: queryOptional(z.enum(['verified', 'known'])),
  includeHidden: queryOptional(QueryBool),
  sort: queryOptional(z.enum(LIBRARY_SORTS)),
});
export type ListLibraryQuery = z.infer<typeof ListLibraryQuery>;

export const LibraryStatus = z.object({
  enabled: z.boolean(),
  registryUrl: z.string(),
  /** Check servers in the background (connect without credentials, lint, GitHub with a token). */
  autoCheck: z.boolean(),
  hasGithubToken: z.boolean(),
  sync: z.object({
    running: z.boolean(),
    mode: z.enum(['full', 'incremental']).nullable(),
    pages: z.number().int().nonnegative(),
    lastRunAt: IsoDateTime.nullable(),
    lastSuccessAt: IsoDateTime.nullable(),
    lastFullAt: IsoDateTime.nullable(),
    lastError: z.string().nullable(),
  }),
  counts: z.object({ total: z.number().int().nonnegative(), remote: z.number().int().nonnegative(), checked: z.number().int().nonnegative() }),
  attribution: z.string(),
});
export type LibraryStatus = z.infer<typeof LibraryStatus>;

export const UpdateLibrarySettingsBody = z.object({
  enabled: z.boolean().optional(),
  registryUrl: z.url().optional(),
  autoCheck: z.boolean().optional(),
  /** Optional GitHub token for repository signals (write-only; null clears it). */
  githubToken: z.string().min(1).max(500).nullable().optional(),
});
export type UpdateLibrarySettingsBody = z.infer<typeof UpdateLibrarySettingsBody>;

export const UpdateLibraryEntryBody = z.object({ hidden: z.boolean() });
export type UpdateLibraryEntryBody = z.infer<typeof UpdateLibraryEntryBody>;

export const libraryEndpoints = {
  status: endpoint({
    method: 'GET', path: '/api/library/status', kind: 'json', access: ['admin'],
    summary: 'Library sync settings and state', response: LibraryStatus,
  }),
  updateSettings: endpoint({
    method: 'PATCH', path: '/api/library/settings', kind: 'json', access: ['admin'],
    summary: 'Enable registry sync, set the registry URL or the GitHub token', body: UpdateLibrarySettingsBody, response: LibraryStatus,
  }),
  sync: endpoint({
    method: 'POST', path: '/api/library/sync', kind: 'json', access: ['admin'],
    summary: 'Start a registry sync now (no-op if one is running)', response: z.object({ started: z.boolean() }),
  }),
  list: endpoint({
    method: 'GET', path: '/api/library', kind: 'json', access: ['admin'],
    summary: 'Search the library', query: ListLibraryQuery, response: Page(LibraryEntryRow),
  }),
  get: endpoint({
    method: 'GET', path: '/api/library/:id', kind: 'json', access: ['admin'],
    summary: 'Library entry with grade breakdown and an Add-to-gateway draft', params: IdParams, response: LibraryEntryDetail,
  }),
  check: endpoint({
    method: 'POST', path: '/api/library/:id/check', kind: 'json', access: ['admin'],
    summary: 'Connect without credentials, lint tool definitions, look up the repository; regrade', params: IdParams, response: LibraryEntryDetail,
  }),
  update: endpoint({
    method: 'PATCH', path: '/api/library/:id', kind: 'json', access: ['admin'],
    summary: 'Hide or unhide an entry', params: IdParams, body: UpdateLibraryEntryBody, response: LibraryEntryDetail,
  }),
} as const;
