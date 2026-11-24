import { createHash, createHmac } from 'node:crypto';
import { encodePath, expectOk, joinKey, type ArchiveFetch, type ArchiveStore } from './store.js';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const sha256Hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data, 'utf8').digest();

/** `YYYYMMDDTHHMMSSZ` */
export function amzDate(ms: number): string {
  return new Date(ms).toISOString().replace(/[:-]|\.\d{3}/g, '');
}

export function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request');
}

/**
 * AWS Signature Version 4 (header auth). Returns the headers to send, including
 * `authorization`, `x-amz-date` and `x-amz-content-sha256` (S3 requires the latter).
 * https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html
 */
export function signV4(input: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Buffer | string;
  region: string;
  service: string;
  credentials: AwsCredentials;
  now: number;
  /** S3 needs the payload hash header; other services may not. */
  contentSha256Header?: boolean;
}): Record<string, string> {
  const u = new URL(input.url);
  const datetime = amzDate(input.now);
  const date = datetime.slice(0, 8);
  const payloadHash = sha256Hex(input.body ?? '');
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) headers[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  headers.host = u.host;
  headers['x-amz-date'] = datetime;
  if (input.contentSha256Header ?? true) headers['x-amz-content-sha256'] = payloadHash;
  if (input.credentials.sessionToken) headers['x-amz-security-token'] = input.credentials.sessionToken;

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalRequest = [input.method.toUpperCase(), u.pathname || '/', query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', datetime, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey(input.credentials.secretAccessKey, date, input.region, input.service)).update(stringToSign, 'utf8').digest('hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export interface S3ArchiveOptions {
  bucket: string;
  prefix: string;
  region: string;
  /** Custom endpoint (MinIO, GCS interop, R2…); default https://s3.<region>.amazonaws.com */
  endpoint?: string;
  /** Path-style addressing (default for custom endpoints). */
  forcePathStyle?: boolean;
  credentials: () => AwsCredentials | Promise<AwsCredentials>;
  fetch: ArchiveFetch;
  now?: () => number;
  kind?: 's3' | 'gcs';
}

/** S3 / S3-compatible PutObject with SigV4 (no SDK dependency). */
export class S3Archive implements ArchiveStore {
  readonly kind: 's3' | 'gcs';
  constructor(private readonly o: S3ArchiveOptions) {
    this.kind = o.kind ?? 's3';
  }

  get location(): string {
    return `${this.kind === 'gcs' ? 'gs' : 's3'}://${this.o.bucket}/${this.o.prefix}`.replace(/\/$/, '');
  }

  objectUrl(key: string): string {
    const name = encodePath(joinKey(this.o.prefix, key));
    const endpoint = (this.o.endpoint ?? `https://s3.${this.o.region}.amazonaws.com`).replace(/\/+$/, '');
    const pathStyle = this.o.forcePathStyle ?? this.o.endpoint !== undefined;
    if (pathStyle) return `${endpoint}/${encodeURIComponent(this.o.bucket)}/${name}`;
    const u = new URL(endpoint);
    return `${u.protocol}//${this.o.bucket}.${u.host}/${name}`;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const url = this.objectUrl(key);
    const headers = signV4({
      method: 'PUT',
      url,
      headers: { 'content-type': contentType, 'content-length': String(body.length) },
      body,
      region: this.o.region,
      service: 's3',
      credentials: await this.o.credentials(),
      now: (this.o.now ?? Date.now)(),
    });
    delete headers.host;
    const res = await this.o.fetch(url, { method: 'PUT', headers, body });
    await expectOk(res, `PUT ${this.location}/${key}`);
  }
}
