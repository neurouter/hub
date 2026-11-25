import type { FetchLike } from '../lib/net/safe-fetch.js';

/**
 * Client for the generic MCP registry API (`GET /v0.1/servers`), implemented by the official
 * registry (https://registry.modelcontextprotocol.io) and by subregistries/mirrors.
 * Pagination is by the opaque `metadata.nextCursor`; incremental sync by `updated_since`.
 */

export const OFFICIAL_META = 'io.modelcontextprotocol.registry/official';

export interface RegistryInput {
  name?: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
}

export interface RegistryServerJson {
  name: string;
  description?: string;
  version: string;
  title?: string;
  websiteUrl?: string;
  icons?: unknown[];
  repository?: { url?: string; source?: string; subfolder?: string };
  packages?: Array<{ registryType?: string; identifier?: string; transport?: { type?: string } }>;
  remotes?: Array<{ type?: string; url?: string; headers?: RegistryInput[]; variables?: Record<string, unknown> }>;
  [k: string]: unknown;
}

export interface RegistryRecord {
  server: RegistryServerJson;
  _meta?: Record<string, unknown>;
}

export interface OfficialMeta {
  status: 'active' | 'deprecated' | 'deleted';
  statusMessage: string | null;
  publishedAt: number | null;
  updatedAt: number | null;
  isLatest: boolean;
}

export interface RegistryPage {
  servers: RegistryRecord[];
  nextCursor: string | null;
}

const ts = (v: unknown): number | null => {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

export function officialMeta(rec: RegistryRecord): OfficialMeta {
  const m = (rec._meta?.[OFFICIAL_META] ?? {}) as Record<string, unknown>;
  const status = m.status === 'deprecated' || m.status === 'deleted' ? m.status : 'active';
  return {
    status,
    statusMessage: typeof m.statusMessage === 'string' ? m.statusMessage : null,
    publishedAt: ts(m.publishedAt),
    updatedAt: ts(m.updatedAt),
    // registries that don't send the flag only return latest versions with `version=latest`
    isLatest: m.isLatest === undefined ? true : m.isLatest === true,
  };
}

export class RegistryError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

export interface RegistryClientOptions {
  fetch: FetchLike;
  baseUrl: string;
  /** Retries on 429/5xx/network errors (default 3), with exponential backoff. */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  userAgent?: string;
}

export class RegistryClient {
  private readonly base: string;

  constructor(private readonly o: RegistryClientOptions) {
    this.base = o.baseUrl.replace(/\/+$/, '');
  }

  /** One page of `/v0.1/servers`. */
  async page(params: { cursor?: string | null; updatedSince?: number | null; latestOnly?: boolean; limit?: number }): Promise<RegistryPage> {
    const u = new URL(`${this.base}/v0.1/servers`);
    u.searchParams.set('limit', String(params.limit ?? 100));
    if (params.latestOnly) u.searchParams.set('version', 'latest');
    if (params.updatedSince) u.searchParams.set('updated_since', new Date(params.updatedSince).toISOString());
    if (params.cursor) u.searchParams.set('cursor', params.cursor);
    const body = await this.getJson(u.toString());
    const servers = Array.isArray((body as { servers?: unknown }).servers) ? ((body as { servers: unknown[] }).servers as RegistryRecord[]) : null;
    if (!servers) throw new RegistryError('The registry response has no "servers" array', null);
    const next = (body as { metadata?: { nextCursor?: unknown } }).metadata?.nextCursor;
    return { servers: servers.filter((s) => s && typeof s === 'object' && s.server && typeof s.server.name === 'string'), nextCursor: typeof next === 'string' && next ? next : null };
  }

  private async getJson(url: string): Promise<unknown> {
    const retries = this.o.retries ?? 3;
    const sleep = this.o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    let last: Error | null = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt) await sleep(1000 * 4 ** (attempt - 1));
      let res: Response;
      try {
        res = await this.o.fetch(url, { headers: { accept: 'application/json', 'user-agent': this.o.userAgent ?? 'neurouter-library-sync' } });
      } catch (err) {
        last = new RegistryError(`Registry request failed: ${(err as Error).message}`, null);
        continue;
      }
      if (res.ok) {
        try {
          return await res.json();
        } catch (err) {
          throw new RegistryError(`The registry returned invalid JSON: ${(err as Error).message}`, res.status);
        }
      }
      await res.body?.cancel().catch(() => {});
      last = new RegistryError(`The registry answered HTTP ${res.status}`, res.status);
      if (res.status !== 429 && res.status < 500) break;
    }
    throw last ?? new RegistryError('Registry request failed', null);
  }
}
