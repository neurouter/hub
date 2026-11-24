import { createHmac } from 'node:crypto';
import { encodePath, expectOk, joinKey, type ArchiveFetch, type ArchiveStore } from './store.js';

export const AZURE_STORAGE_VERSION = '2021-08-06';

export interface AzureArchiveOptions {
  account: string;
  container: string;
  prefix: string;
  /** Shared Key (base64 account key) or a SAS token (without the leading "?"). */
  auth: { sharedKey: string } | { sas: string };
  fetch: ArchiveFetch;
  /** default https://<account>.blob.core.windows.net (Azurite: http://127.0.0.1:10000/<account>) */
  endpoint?: string;
  now?: () => number;
}

/**
 * Shared Key string-to-sign for the Blob service (version 2015-02-21 and later: an empty
 * Content-Length when the body is empty).
 * https://learn.microsoft.com/rest/api/storageservices/authorize-with-shared-key
 */
export function sharedKeyStringToSign(input: { method: string; headers: Record<string, string>; account: string; path: string; query?: URLSearchParams }): string {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) h[k.toLowerCase()] = v;
  const len = h['content-length'] && h['content-length'] !== '0' ? h['content-length'] : '';
  const msHeaders = Object.keys(h)
    .filter((k) => k.startsWith('x-ms-'))
    .sort()
    .map((k) => `${k}:${h[k]!.trim()}\n`)
    .join('');
  let resource = `/${input.account}${input.path}`;
  if (input.query) {
    const keys = [...new Set([...input.query.keys()].map((k) => k.toLowerCase()))].sort();
    for (const k of keys) resource += `\n${k}:${input.query.getAll(k).sort().join(',')}`;
  }
  return [
    input.method.toUpperCase(),
    h['content-encoding'] ?? '',
    h['content-language'] ?? '',
    len,
    h['content-md5'] ?? '',
    h['content-type'] ?? '',
    '', // Date (x-ms-date is used instead)
    h['if-modified-since'] ?? '',
    h['if-match'] ?? '',
    h['if-none-match'] ?? '',
    h['if-unmodified-since'] ?? '',
    h.range ?? '',
    msHeaders + resource,
  ].join('\n');
}

/** Azure Blob Storage Put Blob (BlockBlob) with Shared Key or SAS. */
export class AzureBlobArchive implements ArchiveStore {
  readonly kind = 'azure-blob' as const;
  constructor(private readonly o: AzureArchiveOptions) {}

  get location(): string {
    return `azblob://${this.o.account}/${this.o.container}/${this.o.prefix}`.replace(/\/$/, '');
  }

  blobUrl(key: string): { url: string; canonicalPath: string } {
    const endpoint = (this.o.endpoint ?? `https://${this.o.account}.blob.core.windows.net`).replace(/\/+$/, '');
    const blobPath = `/${encodeURIComponent(this.o.container)}/${encodePath(joinKey(this.o.prefix, key))}`;
    // Shared Key's canonical resource is always /<account>/<container>/<blob>, also for
    // Azurite-style endpoints that carry the account in the URL path
    return { url: `${endpoint}${blobPath}`, canonicalPath: blobPath };
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const { url, canonicalPath } = this.blobUrl(key);
    const headers: Record<string, string> = {
      'content-type': contentType,
      'content-length': String(body.length),
      'x-ms-blob-type': 'BlockBlob',
      'x-ms-date': new Date((this.o.now ?? Date.now)()).toUTCString(),
      'x-ms-version': AZURE_STORAGE_VERSION,
    };
    let target = url;
    if ('sharedKey' in this.o.auth) {
      const sts = sharedKeyStringToSign({ method: 'PUT', headers, account: this.o.account, path: canonicalPath });
      const sig = createHmac('sha256', Buffer.from(this.o.auth.sharedKey, 'base64')).update(sts, 'utf8').digest('base64');
      headers.authorization = `SharedKey ${this.o.account}:${sig}`;
    } else {
      target = `${url}?${this.o.auth.sas.replace(/^\?/, '')}`;
    }
    const res = await this.o.fetch(target, { method: 'PUT', headers, body });
    await expectOk(res, `PUT ${this.location}/${key}`);
  }
}
