import * as z from 'zod';
import { AccessDecision, AgentKind, AgentStatus, ApiKeyStatus } from '../domain/enums.js';
import { Actions, CursorQuery, Id, IdParams, IsoDateTime, Items, Page, Ref, queryOptional, sortParam } from './common.js';
import { endpoint } from './endpoint.js';

/**
 * Agent. Per frontend addendum #1 / decision 40 there is NO tool exposure mode in Phase 1:
 * it is absent from every payload (request bodies are strict, so sending one is a 422).
 */
export const Agent = z.object({
  id: Id,
  name: z.string(),
  description: z.string(),
  owner: Ref,
  kind: AgentKind,
  status: AgentStatus,
  activeKeyCount: z.number().int().nonnegative(),
  lastUsedAt: IsoDateTime.nullable(),
  oauthClient: Ref.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  actions: Actions.optional(),
});
export type Agent = z.infer<typeof Agent>;

export const ApiKey = z.object({
  id: Id,
  name: z.string(),
  /** `nr_live_<keyId>` */
  prefix: z.string(),
  status: ApiKeyStatus,
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime.nullable(),
  lastUsedAt: IsoDateTime.nullable(),
  revokedAt: IsoDateTime.nullable(),
});
export type ApiKey = z.infer<typeof ApiKey>;

/** `restricted` = agent allow-grants narrow the owner's access (backend §5.3). */
export const AgentScope = z.object({
  mode: z.enum(['inherit', 'restricted']),
  serverIds: z.array(Id),
  toolIds: z.array(Id),
});
export type AgentScope = z.infer<typeof AgentScope>;

export const AgentAccess = z.object({
  servers: z.array(
    z.object({
      server: Ref,
      tools: z.array(z.object({ tool: Ref.extend({ qualifiedName: z.string() }), decision: AccessDecision })),
    }),
  ),
});
export type AgentAccess = z.infer<typeof AgentAccess>;

export const AGENT_SORT_FIELDS = ['name', 'lastUsedAt', 'createdAt'] as const;
export const ListAgentsQuery = CursorQuery.extend({
  /** `me` (default), `all` (admin/auditor), or a user id (admin/auditor). */
  owner: queryOptional(z.string().max(128)),
  q: queryOptional(z.string().max(200)),
  sort: sortParam(AGENT_SORT_FIELDS),
  order: queryOptional(z.enum(['asc', 'desc'])),
});
export type ListAgentsQuery = z.infer<typeof ListAgentsQuery>;

export const CreateAgentBody = z.strictObject({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(1000).optional(),
});
export type CreateAgentBody = z.infer<typeof CreateAgentBody>;

export const UpdateAgentBody = z.strictObject({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().max(1000).optional(),
  status: AgentStatus.optional(),
});
export type UpdateAgentBody = z.infer<typeof UpdateAgentBody>;

export const CreateApiKeyBody = z.object({
  name: z.string().trim().min(1).max(100),
  /** null = never expires */
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
});
export type CreateApiKeyBody = z.infer<typeof CreateApiKeyBody>;

/** The secret is returned only here, once. */
export const CreateApiKeyResponse = z.object({ key: ApiKey, secret: z.string() });
export type CreateApiKeyResponse = z.infer<typeof CreateApiKeyResponse>;

export const RevokeAllResponse = z.object({ revoked: z.number().int().nonnegative() });

const KeyParams = z.object({ id: Id, keyId: Id });

export const agentEndpoints = {
  list: endpoint({
    method: 'GET', path: '/api/agents', kind: 'json', access: ['user', 'auditor'],
    summary: 'List agents (own; all for admin/auditor)', query: ListAgentsQuery, response: Page(Agent),
  }),
  create: endpoint({
    method: 'POST', path: '/api/agents', kind: 'json', access: ['user'],
    summary: 'Create an agent', body: CreateAgentBody, response: Agent,
  }),
  get: endpoint({
    method: 'GET', path: '/api/agents/:id', kind: 'json', access: ['self', 'auditor'],
    summary: 'Agent detail with actions', params: IdParams, response: Agent,
  }),
  update: endpoint({
    method: 'PATCH', path: '/api/agents/:id', kind: 'json', access: ['self'],
    summary: 'Edit an agent', params: IdParams, body: UpdateAgentBody, response: Agent,
  }),
  delete: endpoint({
    method: 'DELETE', path: '/api/agents/:id', kind: 'empty', access: ['self'],
    summary: 'Soft delete; revokes keys and OAuth tokens', params: IdParams,
  }),
  keys: endpoint({
    method: 'GET', path: '/api/agents/:id/keys', kind: 'json', access: ['self', 'auditor'],
    summary: 'API keys of an agent', params: IdParams, response: Items(ApiKey),
  }),
  createKey: endpoint({
    method: 'POST', path: '/api/agents/:id/keys', kind: 'json', access: ['self'],
    summary: 'Create an API key (secret returned once)', params: IdParams, body: CreateApiKeyBody, response: CreateApiKeyResponse,
  }),
  revokeKey: endpoint({
    method: 'DELETE', path: '/api/agents/:id/keys/:keyId', kind: 'json', access: ['self'],
    summary: 'Revoke an API key', params: KeyParams, response: ApiKey,
  }),
  revokeAllKeys: endpoint({
    method: 'POST', path: '/api/agents/:id/keys/revoke-all', kind: 'json', access: ['admin'],
    summary: 'Revoke every key of an agent', params: IdParams, response: RevokeAllResponse,
  }),
  getScope: endpoint({
    method: 'GET', path: '/api/agents/:id/scope', kind: 'json', access: ['self', 'auditor'],
    summary: 'Agent narrowing', params: IdParams, response: AgentScope,
  }),
  setScope: endpoint({
    method: 'PUT', path: '/api/agents/:id/scope', kind: 'json', access: ['self'],
    summary: 'Set agent narrowing (ids must be within the owner access, else 422)', params: IdParams, body: AgentScope, response: AgentScope,
  }),
  access: endpoint({
    method: 'GET', path: '/api/agents/:id/access', kind: 'json', access: ['self', 'auditor'],
    summary: 'Effective per-tool access of an agent', params: IdParams, response: AgentAccess,
  }),
} as const;
