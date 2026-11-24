import * as z from 'zod';
import { AccessDecision, GrantEffect, GrantSource, SubjectType, TargetType } from '../domain/enums.js';
import { CursorQuery, Id, IdParams, IsoDateTime, IsoDateTimeInput, Page, Ref, queryOptional } from './common.js';
import { endpoint } from './endpoint.js';

export const GrantSubject = z.object({ type: SubjectType, id: Id, name: z.string() });
export type GrantSubject = z.infer<typeof GrantSubject>;
export const GrantTarget = z.object({ type: TargetType, id: Id, name: z.string(), server: Ref });
export type GrantTarget = z.infer<typeof GrantTarget>;

export const Grant = z.object({
  id: Id,
  subject: GrantSubject,
  target: GrantTarget,
  effect: GrantEffect,
  source: GrantSource,
  accessRequestId: Id.nullable(),
  createdBy: Ref,
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime.nullable(),
});
export type Grant = z.infer<typeof Grant>;

export const SubjectInput = z.object({ type: SubjectType, id: Id });
export type SubjectInput = z.infer<typeof SubjectInput>;
export const TargetInput = z.object({ type: TargetType, id: Id });
export type TargetInput = z.infer<typeof TargetInput>;

export const ListGrantsQuery = CursorQuery.extend({
  subjectType: queryOptional(SubjectType),
  subjectId: queryOptional(Id),
  serverId: queryOptional(Id),
  toolId: queryOptional(Id),
  effect: queryOptional(GrantEffect),
});
export type ListGrantsQuery = z.infer<typeof ListGrantsQuery>;

export const CreateGrantBody = z.object({
  subject: SubjectInput,
  target: TargetInput,
  effect: GrantEffect,
  expiresAt: IsoDateTimeInput.nullable().optional(),
});
export type CreateGrantBody = z.infer<typeof CreateGrantBody>;

export const BatchGrantsBody = z.object({
  upserts: z.array(CreateGrantBody).max(1000),
  deletes: z.array(Id).max(1000),
});
export type BatchGrantsBody = z.infer<typeof BatchGrantsBody>;
export const BatchGrantsResponse = z.object({
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
});
export type BatchGrantsResponse = z.infer<typeof BatchGrantsResponse>;

export const EffectiveAccessQuery = z.object({
  subjectType: z.enum(['user', 'agent']),
  subjectId: Id,
  serverId: queryOptional(Id),
  toolId: queryOptional(Id),
});
export type EffectiveAccessQuery = z.infer<typeof EffectiveAccessQuery>;

export const EffectiveReason = z.object({
  grantId: Id,
  subject: GrantSubject,
  target: GrantTarget,
  effect: GrantEffect,
});
export type EffectiveReason = z.infer<typeof EffectiveReason>;

/**
 * How a per-tool decision was reached (frontend addendum #6: the access matrix shows inherited
 * access as a muted badge with a tooltip naming its source).
 * - `direct`: a grant on this tool for this subject
 * - `server`: a server-wide grant
 * - `group`: via one of the user's groups
 * - `owner`: an agent inheriting its owner's access
 */
export const AccessVia = z.object({
  kind: z.enum(['direct', 'server', 'group', 'owner']),
  grantId: Id,
  subject: GrantSubject,
});
export type AccessVia = z.infer<typeof AccessVia>;

export const EffectiveAccess = z.object({
  decision: AccessDecision,
  reasons: z.array(EffectiveReason),
  perTool: z
    .array(
      z.object({
        toolId: Id,
        qualifiedName: z.string(),
        decision: AccessDecision,
        inherited: z.boolean().optional(),
        via: z.array(AccessVia).optional(),
      }),
    )
    .optional(),
});
export type EffectiveAccess = z.infer<typeof EffectiveAccess>;

export const grantEndpoints = {
  list: endpoint({
    method: 'GET', path: '/api/grants', kind: 'json', access: ['owner', 'auditor', 'user'],
    summary: 'List grants (owners: owned targets; users: own agents)', query: ListGrantsQuery, response: Page(Grant),
  }),
  create: endpoint({
    method: 'POST', path: '/api/grants', kind: 'json', status: 201, access: ['owner'],
    summary: 'Create a grant (409 on duplicate)', body: CreateGrantBody, response: Grant,
  }),
  delete: endpoint({
    method: 'DELETE', path: '/api/grants/:id', kind: 'empty', access: ['owner'],
    summary: 'Remove a grant', params: IdParams,
  }),
  batch: endpoint({
    method: 'POST', path: '/api/grants/batch', kind: 'json', access: ['owner'],
    summary: 'Atomic matrix save (422 lists offending entries)', body: BatchGrantsBody, response: BatchGrantsResponse,
  }),
  effective: endpoint({
    method: 'GET', path: '/api/grants/effective', kind: 'json', access: ['owner', 'auditor', 'user'],
    summary: 'Explain effective access', query: EffectiveAccessQuery, response: EffectiveAccess,
  }),
} as const;
