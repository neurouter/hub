import * as z from 'zod';
import { SUPPORTED_PROTOCOL_VERSIONS } from '../version.js';
import { Id, IsoDateTime, JobAccepted, queryArray } from './common.js';
import { endpoint } from './endpoint.js';
import { JobKind, JobStatus } from '../domain/enums.js';

export const ProtocolVersion = z.enum(SUPPORTED_PROTOCOL_VERSIONS);

export const SystemInfo = z.object({
  version: z.string(),
  dbDialect: z.enum(['sqlite', 'postgres']).optional(),
  searchMode: z.enum(['hybrid', 'keyword']),
  embeddingModel: z.string().nullable().optional(),
  embeddingReady: z.boolean().optional(),
  /** Admins only: tools with an embedding for the current model vs. all live tools. */
  searchIndex: z.object({ tools: z.number().int().nonnegative(), embedded: z.number().int().nonnegative() }).optional(),
  instanceId: z.string().optional(),
  mcpUrl: z.string(),
  protocolVersions: z.array(ProtocolVersion),
});
export type SystemInfo = z.infer<typeof SystemInfo>;

/** Kinds of ids the name lookup resolves (filter chips keep only ids in the URL). */
export const LookupType = z.enum(['user', 'group', 'agent', 'server', 'tool']);
export type LookupType = z.infer<typeof LookupType>;
export const LookupNamesQuery = z.object({ ids: queryArray(Id) });
export type LookupNamesQuery = z.infer<typeof LookupNamesQuery>;
/** Only ids the viewer may see are returned; unknown or hidden ids are left out. */
export const LookupNames = z.object({ names: z.record(z.string(), z.object({ type: LookupType, name: z.string() })) });
export type LookupNames = z.infer<typeof LookupNames>;

export const RotateKeysBody = z.object({ type: z.enum(['dek', 'rewrap']) });
export type RotateKeysBody = z.infer<typeof RotateKeysBody>;

export const Job = z.object({
  id: Id,
  kind: JobKind,
  status: JobStatus,
  progress: z.number().min(0).max(1).nullable(),
  result: z.unknown().nullable(),
  error: z.string().nullable(),
  createdAt: IsoDateTime,
  finishedAt: IsoDateTime.nullable(),
});
export type Job = z.infer<typeof Job>;

export const SyncJobResult = z.object({
  added: z.number().int(), changed: z.number().int(), removed: z.number().int(), unchanged: z.number().int(),
});
export type SyncJobResult = z.infer<typeof SyncJobResult>;

export const systemEndpoints = {
  info: endpoint({
    method: 'GET', path: '/api/system/info', kind: 'json', access: ['user', 'admin'],
    summary: 'Version and runtime info (limited for users, full for admins)', response: SystemInfo,
  }),
  rotateKeys: endpoint({
    method: 'POST', path: '/api/system/keys/rotate', kind: 'json', status: 202, access: ['admin'],
    summary: 'Rotate the DEK or rewrap DEKs under the active KEK', body: RotateKeysBody, response: JobAccepted,
  }),
  names: endpoint({
    method: 'GET', path: '/api/lookup/names', kind: 'json', access: ['user'],
    summary: 'Display names for up to 100 ids the viewer may see (filter chips; 422 above 100)', query: LookupNamesQuery, response: LookupNames,
  }),
  reindex: endpoint({
    method: 'POST', path: '/api/system/reindex', kind: 'json', status: 202, access: ['admin'],
    summary: 'Re-embed all tools', response: JobAccepted,
  }),
} as const;

export const jobEndpoints = {
  get: endpoint({
    method: 'GET', path: '/api/jobs/:id', kind: 'json', access: ['self', 'auditor'],
    summary: 'Async job status', params: z.object({ id: Id }), response: Job,
  }),
} as const;
