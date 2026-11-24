import * as z from 'zod';
import { HealthStatus, ServerAuthType } from '../domain/enums.js';
import { CursorQuery, Id, IdParams, JsonObject, Page, Ref, queryArray, queryOptional, sortParam } from './common.js';
import { ToolRateLimit } from './tools.js';
import { endpoint } from './endpoint.js';

export const CatalogServerAccess = z.enum(['granted', 'partial', 'none', 'pending']);
export type CatalogServerAccess = z.infer<typeof CatalogServerAccess>;
export const CatalogToolAccess = z.enum(['allowed', 'denied', 'none', 'pending']);
export type CatalogToolAccess = z.infer<typeof CatalogToolAccess>;
export const CatalogConnection = z.enum(['connected', 'not_connected', 'expired', 'not_required']);
export type CatalogConnection = z.infer<typeof CatalogConnection>;

export const CatalogServer = z.object({
  id: Id,
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  iconUrl: z.string().nullable(),
  tags: z.array(z.string()),
  owner: Ref,
  toolCount: z.number().int().nonnegative(),
  access: CatalogServerAccess,
  health: z.object({ status: HealthStatus }),
  authType: ServerAuthType,
  connection: CatalogConnection,
});
export type CatalogServer = z.infer<typeof CatalogServer>;

export const CatalogServerTool = z.object({
  id: Id,
  name: z.string(),
  qualifiedName: z.string(),
  title: z.string().nullable(),
  description: z.string(),
  inputSchema: JsonObject,
  access: CatalogToolAccess,
  requiresApproval: z.boolean(),
  rateLimit: ToolRateLimit.nullable(),
});
export type CatalogServerTool = z.infer<typeof CatalogServerTool>;

export const CatalogServerDetail = CatalogServer.extend({ tools: z.array(CatalogServerTool) });
export type CatalogServerDetail = z.infer<typeof CatalogServerDetail>;

export const CatalogTool = z.object({
  id: Id,
  qualifiedName: z.string(),
  title: z.string().nullable(),
  description: z.string(),
  server: Ref,
  access: CatalogToolAccess,
  requiresApproval: z.boolean(),
  /** relevance score when `q` is set (the UI does not display it) */
  score: z.number().nullable(),
});
export type CatalogTool = z.infer<typeof CatalogTool>;

/** Tool search page; `suggestion` is a corrected query ("Did you mean") when `q` found nothing. */
export const CatalogToolsPage = Page(CatalogTool).extend({ suggestion: z.string().nullable().optional() });
export type CatalogToolsPage = z.infer<typeof CatalogToolsPage>;

export const CatalogAccessFilter = z.enum(['all', 'granted', 'requestable']);
export const CATALOG_SERVER_SORT_FIELDS = ['name', 'toolCount'] as const;

export const ListCatalogServersQuery = CursorQuery.extend({
  q: queryOptional(z.string().max(200)),
  tag: queryArray(z.string().max(50)),
  access: queryOptional(CatalogAccessFilter),
  sort: sortParam(CATALOG_SERVER_SORT_FIELDS),
});
export type ListCatalogServersQuery = z.infer<typeof ListCatalogServersQuery>;

export const ListCatalogToolsQuery = CursorQuery.extend({
  q: queryOptional(z.string().max(500)),
  serverId: queryOptional(Id),
  access: queryOptional(CatalogAccessFilter),
});
export type ListCatalogToolsQuery = z.infer<typeof ListCatalogToolsQuery>;

export const CatalogTags = z.object({ tags: z.array(z.object({ name: z.string(), count: z.number().int().nonnegative() })) });
export type CatalogTags = z.infer<typeof CatalogTags>;

export const catalogEndpoints = {
  servers: endpoint({
    method: 'GET', path: '/api/catalog/servers', kind: 'json', access: ['user'],
    summary: 'Browse servers', query: ListCatalogServersQuery, response: Page(CatalogServer),
  }),
  server: endpoint({
    method: 'GET', path: '/api/catalog/servers/:id', kind: 'json', access: ['user'],
    summary: 'Catalog server detail with tools', params: IdParams, response: CatalogServerDetail,
  }),
  tools: endpoint({
    method: 'GET', path: '/api/catalog/tools', kind: 'json', access: ['user'],
    summary: 'Tool search (hybrid with q, alphabetical without)', query: ListCatalogToolsQuery, response: CatalogToolsPage,
  }),
  tags: endpoint({
    method: 'GET', path: '/api/catalog/tags', kind: 'json', access: ['user'],
    summary: 'Tag facet', response: CatalogTags,
  }),
} as const;
