import * as z from 'zod';
import { OAuthRegistration } from '../domain/enums.js';
import { CursorQuery, Id, IdParams, IsoDateTime, Items, Page, Ref, queryOptional } from './common.js';
import { endpoint } from './endpoint.js';

export const MCP_SCOPE_TOOLS = 'mcp:tools';

export const ConsentRequest = z.object({
  client: z.object({
    /** client_id URL (CIMD) or generated id (DCR / pre-registered) */
    id: z.string(),
    idHost: z.string().nullable(),
    name: z.string(),
    /** only when served from the client_id host (CIMD) */
    logoUri: z.string().nullable(),
    clientUri: z.string().nullable(),
    registration: OAuthRegistration,
    /** true for CIMD; DCR / unverified clients show "Unverified app" + redirect host (frontend addendum #7) */
    verified: z.boolean(),
  }),
  redirectUri: z.string(),
  redirectHost: z.string(),
  localhostOnly: z.boolean(),
  scopes: z.array(z.object({ name: z.string(), description: z.string() })),
  resource: z.string(),
  expiresAt: IsoDateTime,
  user: z.object({ email: z.string() }),
  agents: z.array(Ref),
});
export type ConsentRequest = z.infer<typeof ConsentRequest>;

export const ConsentParams = z.object({ requestId: Id });

export const ConsentDecisionBody = z.object({
  decision: z.enum(['approve', 'deny']),
  agentId: Id.optional(),
  agentName: z.string().trim().min(1).max(100).optional(),
  /** must be ⊆ requested; P1 has one scope */
  scopes: z.array(z.string()).optional(),
});
export type ConsentDecisionBody = z.infer<typeof ConsentDecisionBody>;

export const RedirectResponse = z.object({ redirectTo: z.string() });
export type RedirectResponse = z.infer<typeof RedirectResponse>;

export const OAuthGrantItem = z.object({
  id: Id,
  client: z.object({ name: z.string(), id: z.string() }),
  agent: Ref,
  scopes: z.array(z.string()),
  createdAt: IsoDateTime,
  lastUsedAt: IsoDateTime.nullable(),
});
export type OAuthGrantItem = z.infer<typeof OAuthGrantItem>;

export const ListOAuthGrantsQuery = z.object({ agentId: queryOptional(Id) });

export const OAuthClientStatus = z.enum(['active', 'blocked']);
export const OAuthClientRow = z.object({
  id: Id,
  clientId: z.string(),
  name: z.string(),
  registration: OAuthRegistration,
  redirectUris: z.array(z.string()),
  status: OAuthClientStatus,
  userCount: z.number().int().nonnegative(),
  lastUsedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type OAuthClientRow = z.infer<typeof OAuthClientRow>;

export const ListOAuthClientsQuery = CursorQuery.extend({
  q: queryOptional(z.string().max(200)),
  registration: queryOptional(OAuthRegistration),
  status: queryOptional(OAuthClientStatus),
});
export const UpdateOAuthClientBody = z.object({ status: OAuthClientStatus });

export const oauthEndpoints = {
  getConsent: endpoint({
    method: 'GET', path: '/api/oauth/consent/:requestId', kind: 'json', access: ['user'],
    summary: 'Consent details (410 expired, 404 unknown, 403 other user)', params: ConsentParams, response: ConsentRequest,
  }),
  decideConsent: endpoint({
    method: 'POST', path: '/api/oauth/consent/:requestId', kind: 'json', access: ['user'],
    summary: 'Approve / deny; redirectTo carries code|error, state and iss', params: ConsentParams, body: ConsentDecisionBody, response: RedirectResponse,
  }),
  myGrants: endpoint({
    method: 'GET', path: '/api/me/oauth-grants', kind: 'json', access: ['user'],
    summary: 'Authorized MCP clients', query: ListOAuthGrantsQuery, response: Items(OAuthGrantItem),
  }),
  revokeMyGrant: endpoint({
    method: 'DELETE', path: '/api/me/oauth-grants/:id', kind: 'empty', access: ['self'],
    summary: 'Revoke consent and its token family', params: IdParams,
  }),
  clients: endpoint({
    method: 'GET', path: '/api/oauth-clients', kind: 'json', access: ['admin', 'auditor'],
    summary: 'Registered OAuth clients', query: ListOAuthClientsQuery, response: Page(OAuthClientRow),
  }),
  updateClient: endpoint({
    method: 'PATCH', path: '/api/oauth-clients/:id', kind: 'json', access: ['admin'],
    summary: 'Block / unblock a client', params: IdParams, body: UpdateOAuthClientBody, response: OAuthClientRow,
  }),
} as const;
