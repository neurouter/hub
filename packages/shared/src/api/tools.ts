import * as z from 'zod';
import { ToolReviewState, ToolVersionDecision } from '../domain/enums.js';
import { Actions, CursorQuery, Id, IdParams, IsoDateTime, JsonObject, Page, QueryBool, Ref, ServerRef, queryArray, queryOptional, sortParam } from './common.js';
import { endpoint } from './endpoint.js';

export const ToolRateLimit = z.object({ perMinute: z.number().int().positive(), burst: z.number().int().positive() });
export type ToolRateLimit = z.infer<typeof ToolRateLimit>;

export const ToolRow = z.object({
  id: Id,
  server: ServerRef,
  /** upstream name */
  name: z.string(),
  /** exposed `<slug>__<name>` (or alias) */
  qualifiedName: z.string(),
  title: z.string().nullable(),
  description: z.string(),
  enabled: z.boolean(),
  requiresApproval: z.boolean(),
  reviewState: ToolReviewState,
  upstreamPresent: z.boolean(),
  rateLimit: ToolRateLimit.nullable(),
  calls24h: z.number().int().nonnegative(),
  lastCalledAt: IsoDateTime.nullable(),
});
export type ToolRow = z.infer<typeof ToolRow>;

export const ToolDetail = ToolRow.extend({
  inputSchema: JsonObject,
  outputSchema: JsonObject.nullable(),
  annotations: JsonObject.nullable(),
  annotationsTrusted: z.boolean(),
  pinnedHash: z.string().nullable(),
  pinnedAt: IsoDateTime.nullable(),
  pinnedBy: Ref.nullable(),
  approvalTimeoutSec: z.number().int().positive().nullable(),
  hasPendingChange: z.boolean(),
  actions: Actions,
});
export type ToolDetail = z.infer<typeof ToolDetail>;

const DefinitionSnapshot = z.object({
  hash: z.string(),
  title: z.string().nullable(),
  description: z.string(),
  inputSchema: JsonObject,
  outputSchema: JsonObject.nullable(),
  annotations: JsonObject.nullable(),
});

export const DefinitionDiff = z.object({
  /** null for a new tool */
  pinned: DefinitionSnapshot.extend({ pinnedAt: IsoDateTime, pinnedBy: Ref }).nullable(),
  current: DefinitionSnapshot.extend({ detectedAt: IsoDateTime }),
});
export type DefinitionDiff = z.infer<typeof DefinitionDiff>;

export const ToolVersion = z.object({
  id: Id,
  hash: z.string(),
  firstSeenAt: IsoDateTime,
  decision: ToolVersionDecision,
  decidedBy: Ref.nullable(),
  decidedAt: IsoDateTime.nullable(),
});
export type ToolVersion = z.infer<typeof ToolVersion>;

export const TOOL_SORT_FIELDS = ['name', 'lastCalledAt', 'calls24h'] as const;
export const ToolListStatus = z.enum(['enabled', 'disabled', 'pending_review']);
export const ListToolsQuery = CursorQuery.extend({
  q: queryOptional(z.string().max(200)),
  serverId: queryArray(Id),
  status: queryOptional(ToolListStatus),
  requiresApproval: queryOptional(QueryBool),
  sort: sortParam(TOOL_SORT_FIELDS),
  order: queryOptional(z.enum(['asc', 'desc'])),
});
export type ListToolsQuery = z.infer<typeof ListToolsQuery>;

export const UpdateToolBody = z.object({
  enabled: z.boolean().optional(),
  requiresApproval: z.boolean().optional(),
  approvalTimeoutSec: z.number().int().min(10).max(3600).nullable().optional(),
  /** null = inherit defaults */
  rateLimit: ToolRateLimit.nullable().optional(),
});
export type UpdateToolBody = z.infer<typeof UpdateToolBody>;

export const BulkToolsBody = z.object({
  ids: z.array(Id).min(1).max(500),
  patch: z.object({ enabled: z.boolean().optional(), requiresApproval: z.boolean().optional() }),
});
export type BulkToolsBody = z.infer<typeof BulkToolsBody>;
export const BulkToolsResponse = z.object({
  updated: z.number().int().nonnegative(),
  skipped: z.array(z.object({ id: Id, reason: z.string() })),
});
export type BulkToolsResponse = z.infer<typeof BulkToolsResponse>;

export const ApproveDefinitionBody = z.object({ hash: z.string().min(1).max(128) });
export type ApproveDefinitionBody = z.infer<typeof ApproveDefinitionBody>;
export const RejectDefinitionBody = z.object({ note: z.string().max(1000).optional() });
export type RejectDefinitionBody = z.infer<typeof RejectDefinitionBody>;

export const toolEndpoints = {
  list: endpoint({
    method: 'GET', path: '/api/tools', kind: 'json', access: ['owner', 'auditor'],
    summary: 'List tools (owners: owned servers)', query: ListToolsQuery, response: Page(ToolRow),
  }),
  get: endpoint({
    method: 'GET', path: '/api/tools/:id', kind: 'json', access: ['owner', 'auditor'],
    summary: 'Tool detail', params: IdParams, response: ToolDetail,
  }),
  update: endpoint({
    method: 'PATCH', path: '/api/tools/:id', kind: 'json', access: ['owner'],
    summary: 'Tool policy (enabling a pending_review tool → 409)', params: IdParams, body: UpdateToolBody, response: ToolDetail,
  }),
  bulk: endpoint({
    method: 'POST', path: '/api/tools/bulk', kind: 'json', access: ['owner'],
    summary: 'Bulk policy update', body: BulkToolsBody, response: BulkToolsResponse,
  }),
  definitionDiff: endpoint({
    method: 'GET', path: '/api/tools/:id/definition-diff', kind: 'json', access: ['owner', 'auditor'],
    summary: 'Pinned vs current definition', params: IdParams, response: DefinitionDiff,
  }),
  approveDefinition: endpoint({
    method: 'POST', path: '/api/tools/:id/approve-definition', kind: 'json', access: ['owner'],
    summary: 'Approve (pin) the reviewed definition hash (409 when stale)', params: IdParams, body: ApproveDefinitionBody, response: ToolDetail,
  }),
  rejectDefinition: endpoint({
    method: 'POST', path: '/api/tools/:id/reject-definition', kind: 'json', access: ['owner'],
    summary: 'Reject the pending definition (tool stays blocked)', params: IdParams, body: RejectDefinitionBody, response: ToolDetail,
  }),
  versions: endpoint({
    method: 'GET', path: '/api/tools/:id/versions', kind: 'json', access: ['owner', 'auditor'],
    summary: 'Definition history', params: IdParams, query: CursorQuery, response: Page(ToolVersion),
  }),
} as const;
