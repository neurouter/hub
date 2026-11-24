/**
 * Object storage for audit archives (approved addendum 3). The retention job writes each expiring
 * UTC day as gzip NDJSON plus a manifest BEFORE it deletes anything. Implementations: local-fs
 * (dev default), s3 (also MinIO / S3-compatible), gcs and azure-blob.
 */
export interface ArchiveStore {
  readonly kind: 'local-fs' | 's3' | 'gcs' | 'azure-blob';
  /** Human-readable location (no credentials), for logs and manifests. */
  readonly location: string;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
}

export type ArchiveFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: Buffer }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export class ArchiveError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ArchiveError';
  }
}

/** Joins a prefix and a key into an object name ("a/b" + "c" → "a/b/c"). */
export function joinKey(prefix: string, key: string): string {
  const p = prefix.replace(/^\/+|\/+$/g, '');
  return p ? `${p}/${key}` : key;
}

/** RFC 3986 encoding of each path segment (keeps "/"). */
export function encodePath(path: string): string {
  return path
    .split('/')
    .map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/');
}

export async function expectOk(res: { ok: boolean; status: number; text(): Promise<string> }, what: string): Promise<void> {
  if (res.ok) return;
  const body = (await res.text().catch(() => '')).slice(0, 300);
  throw new ArchiveError(`${what} failed with HTTP ${res.status}${body ? `: ${body}` : ''}`, res.status);
}
