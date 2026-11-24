import * as z from 'zod';
import { ProtocolVersion } from './system.js';
import { endpoint } from './endpoint.js';

export const ClientConfig = z.object({
  mcpUrl: z.string(),
  oauthSupported: z.boolean(),
  protocolVersions: z.array(ProtocolVersion),
  serverName: z.string(),
  apiKeyHeader: z.string(),
});
export type ClientConfig = z.infer<typeof ClientConfig>;

export const portalEndpoints = {
  clientConfig: endpoint({
    method: 'GET', path: '/api/portal/client-config', kind: 'json', access: ['user'],
    summary: 'Data for the "Connect a client" snippets', response: ClientConfig,
  }),
} as const;
