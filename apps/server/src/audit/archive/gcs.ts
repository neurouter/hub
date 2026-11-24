import { encodePath, expectOk, joinKey, type ArchiveFetch, type ArchiveStore } from './store.js';

/** GCE/GKE metadata server token endpoint (workload identity / attached service account). */
export const GCE_METADATA_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

export interface GcsArchiveOptions {
  bucket: string;
  prefix: string;
  /** Returns an OAuth2 access token with devstorage write scope. */
  token: () => Promise<string>;
  fetch: ArchiveFetch;
  /** default https://storage.googleapis.com */
  endpoint?: string;
}

/**
 * Google Cloud Storage via the JSON API simple upload (`uploadType=media`) with a bearer token.
 * HMAC keys (S3 interoperability) are served by `S3Archive` against storage.googleapis.com instead.
 */
export class GcsArchive implements ArchiveStore {
  readonly kind = 'gcs' as const;
  constructor(private readonly o: GcsArchiveOptions) {}

  get location(): string {
    return `gs://${this.o.bucket}/${this.o.prefix}`.replace(/\/$/, '');
  }

  uploadUrl(key: string): string {
    const endpoint = (this.o.endpoint ?? 'https://storage.googleapis.com').replace(/\/+$/, '');
    return `${endpoint}/upload/storage/v1/b/${encodeURIComponent(this.o.bucket)}/o?uploadType=media&name=${encodeURIComponent(joinKey(this.o.prefix, key))}`;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const token = await this.o.token();
    const res = await this.o.fetch(this.uploadUrl(key), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': contentType, 'content-length': String(body.length) }, body });
    await expectOk(res, `upload ${this.location}/${encodePath(key)}`);
  }
}

/** Caching token source over the GCE metadata server. */
export function metadataTokenSource(fetch: ArchiveFetch, now: () => number = Date.now): () => Promise<string> {
  let cached: { token: string; exp: number } | null = null;
  return async () => {
    if (cached && cached.exp - 60_000 > now()) return cached.token;
    const res = await fetch(GCE_METADATA_TOKEN_URL, { method: 'GET', headers: { 'metadata-flavor': 'Google' } });
    await expectOk(res, 'GCE metadata token');
    const body = JSON.parse(await res.text()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error('GCE metadata server returned no access_token');
    cached = { token: body.access_token, exp: now() + (body.expires_in ?? 300) * 1000 };
    return cached.token;
  };
}
