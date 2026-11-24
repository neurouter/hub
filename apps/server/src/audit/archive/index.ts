import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AzureBlobArchive } from './azure.js';
import { GcsArchive, metadataTokenSource } from './gcs.js';
import { LocalFsArchive } from './local-fs.js';
import { S3Archive } from './s3.js';
import type { ArchiveFetch, ArchiveStore } from './store.js';

export type { ArchiveStore } from './store.js';
export { ArchiveError } from './store.js';

export class ArchiveConfigError extends Error {
  constructor(message: string) {
    super(`AUDIT_ARCHIVE_URL: ${message}`);
    this.name = 'ArchiveConfigError';
  }
}

const defaultFetch: ArchiveFetch = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, ...(init.body ? { body: new Uint8Array(init.body) } : {}), redirect: 'error', signal: AbortSignal.timeout(60_000) });
  return { ok: res.ok, status: res.status, text: () => res.text() };
};

/**
 * Builds the ArchiveStore from `AUDIT_ARCHIVE_URL` (credentials come from the environment,
 * never from the URL):
 *
 * - `file:///var/lib/neurouter/archive` or `file:./data/archive` → local-fs
 * - `s3://bucket/prefix?region=eu-west-1[&endpoint=https://minio:9000][&forcePathStyle=true]`
 *   → AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN (region also AWS_REGION)
 * - `gs://bucket/prefix` → GCS_HMAC_ACCESS_KEY_ID + GCS_HMAC_SECRET (S3 interop), else
 *   GOOGLE_OAUTH_ACCESS_TOKEN, else the GCE/GKE metadata server
 * - `azblob://account/container/prefix[?endpoint=…]` → AZURE_STORAGE_KEY (Shared Key) or
 *   AZURE_STORAGE_SAS_TOKEN
 */
export function createArchiveStore(url: string | undefined | null, env: NodeJS.ProcessEnv = process.env, fetchImpl: ArchiveFetch = defaultFetch, baseDir = process.cwd()): ArchiveStore | null {
  if (!url) return null;
  if (url.startsWith('file:')) {
    const raw = url.startsWith('file://') ? fileURLToPath(url) : url.slice('file:'.length);
    if (!raw) throw new ArchiveConfigError('file: URL needs a path');
    return new LocalFsArchive(isAbsolute(raw) ? raw : resolve(baseDir, raw));
  }
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ArchiveConfigError('not a valid URL');
  }
  if (u.username || u.password) throw new ArchiveConfigError('credentials must come from the environment, not the URL');
  const prefix = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
  switch (u.protocol) {
    case 's3:': {
      const accessKeyId = env.AWS_ACCESS_KEY_ID;
      const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
      if (!accessKeyId || !secretAccessKey) throw new ArchiveConfigError('s3 needs AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY');
      const region = u.searchParams.get('region') ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? 'us-east-1';
      const endpoint = u.searchParams.get('endpoint') ?? undefined;
      const fps = u.searchParams.get('forcePathStyle');
      return new S3Archive({
        bucket: u.hostname,
        prefix,
        region,
        ...(endpoint ? { endpoint } : {}),
        ...(fps !== null ? { forcePathStyle: fps === 'true' } : {}),
        credentials: () => ({ accessKeyId, secretAccessKey, ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}) }),
        fetch: fetchImpl,
      });
    }
    case 'gs:': {
      if (env.GCS_HMAC_ACCESS_KEY_ID && env.GCS_HMAC_SECRET) {
        const creds = { accessKeyId: env.GCS_HMAC_ACCESS_KEY_ID, secretAccessKey: env.GCS_HMAC_SECRET };
        return new S3Archive({ kind: 'gcs', bucket: u.hostname, prefix, region: 'auto', endpoint: 'https://storage.googleapis.com', forcePathStyle: true, credentials: () => creds, fetch: fetchImpl });
      }
      const staticToken = env.GOOGLE_OAUTH_ACCESS_TOKEN;
      return new GcsArchive({ bucket: u.hostname, prefix, token: staticToken ? async () => staticToken : metadataTokenSource(fetchImpl), fetch: fetchImpl });
    }
    case 'azblob:': {
      const [container, ...rest] = prefix.split('/');
      if (!container) throw new ArchiveConfigError('azblob URL needs azblob://<account>/<container>[/prefix]');
      const auth = env.AZURE_STORAGE_KEY ? { sharedKey: env.AZURE_STORAGE_KEY } : env.AZURE_STORAGE_SAS_TOKEN ? { sas: env.AZURE_STORAGE_SAS_TOKEN } : null;
      if (!auth) throw new ArchiveConfigError('azblob needs AZURE_STORAGE_KEY or AZURE_STORAGE_SAS_TOKEN');
      const endpoint = u.searchParams.get('endpoint') ?? undefined;
      return new AzureBlobArchive({ account: u.hostname, container, prefix: rest.join('/'), auth, fetch: fetchImpl, ...(endpoint ? { endpoint } : {}) });
    }
    default:
      throw new ArchiveConfigError(`unsupported scheme ${u.protocol} (use file:, s3:, gs: or azblob:)`);
  }
}
