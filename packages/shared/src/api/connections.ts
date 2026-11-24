import * as z from 'zod';
import { ConnectionStatus } from '../domain/enums.js';
import { Id, IsoDateTime, Items, Ref } from './common.js';
import { endpoint } from './endpoint.js';

export const Connection = z.object({
  server: Ref,
  status: ConnectionStatus,
  accountLabel: z.string().nullable(),
  scopes: z.array(z.string()),
  connectedAt: IsoDateTime.nullable(),
  expiresAt: IsoDateTime.nullable(),
  error: z.string().nullable(),
});
export type Connection = z.infer<typeof Connection>;

export const ConnectionServerParams = z.object({ serverId: Id });
export const AuthorizeConnectionQuery = z.object({ returnTo: z.string().max(2048).optional() });

export const connectionEndpoints = {
  list: endpoint({
    method: 'GET', path: '/api/me/connections', kind: 'json', access: ['user'],
    summary: 'My upstream OAuth connections', response: Items(Connection),
  }),
  authorize: endpoint({
    method: 'GET', path: '/api/me/connections/:serverId/authorize', kind: 'navigation', status: 302, access: ['user'],
    summary: 'Start per-user upstream OAuth (302 to the upstream AS)', params: ConnectionServerParams, query: AuthorizeConnectionQuery,
  }),
  disconnect: endpoint({
    method: 'DELETE', path: '/api/me/connections/:serverId', kind: 'empty', access: ['self'],
    summary: 'Disconnect (best-effort upstream revocation)', params: ConnectionServerParams,
  }),
} as const;
