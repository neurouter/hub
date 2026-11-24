import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AzureBlobArchive, sharedKeyStringToSign } from './azure.js';
import { GcsArchive } from './gcs.js';
import { ArchiveConfigError, createArchiveStore } from './index.js';
import { LocalFsArchive } from './local-fs.js';
import { S3Archive, signingKey, signV4 } from './s3.js';
import type { ArchiveFetch } from './store.js';

const recorder = () => {
  const calls: { url: string; init: Parameters<ArchiveFetch>[1] }[] = [];
  const fetch: ArchiveFetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => '' };
  };
  return { calls, fetch };
};

describe('SigV4', () => {
  // AWS documentation example (IAM ListUsers, 2015-08-30T12:36:00Z, us-east-1)
  const creds = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
  it('derives the documented signing key', () => {
    expect(signingKey(creds.secretAccessKey, '20150830', 'us-east-1', 'iam').toString('hex')).toBe('c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9');
  });
  it('produces the documented signature', () => {
    const h = signV4({
      method: 'GET',
      url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      region: 'us-east-1',
      service: 'iam',
      credentials: creds,
      now: Date.UTC(2015, 7, 30, 12, 36, 0),
      contentSha256Header: false,
    });
    expect(h.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
  });
});

describe('S3 / GCS / Azure archive stores', () => {
  it('S3 PUTs virtual-hosted on AWS and path-style on custom endpoints, signed', async () => {
    const { calls, fetch } = recorder();
    const aws = new S3Archive({ bucket: 'b', prefix: 'neuro/', region: 'eu-west-1', credentials: () => ({ accessKeyId: 'A', secretAccessKey: 'S', sessionToken: 'T' }), fetch, now: () => 0 });
    await aws.put('audit/2026/x y.gz', Buffer.from('hi'), 'application/gzip');
    expect(calls[0]!.url).toBe('https://b.s3.eu-west-1.amazonaws.com/neuro/audit/2026/x%20y.gz');
    expect(calls[0]!.init.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=A\/19700101\/eu-west-1\/s3\/aws4_request, SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/);
    expect(calls[0]!.init.headers.host).toBeUndefined();
    const minio = new S3Archive({ bucket: 'b', prefix: '', region: 'us-east-1', endpoint: 'http://minio:9000', credentials: () => ({ accessKeyId: 'A', secretAccessKey: 'S' }), fetch });
    expect(minio.objectUrl('k')).toBe('http://minio:9000/b/k');
  });

  it('reports a failed upload with status', async () => {
    const s = new S3Archive({ bucket: 'b', prefix: '', region: 'us-east-1', credentials: () => ({ accessKeyId: 'A', secretAccessKey: 'S' }), fetch: async () => ({ ok: false, status: 403, text: async () => 'AccessDenied' }) });
    await expect(s.put('k', Buffer.from(''), 'text/plain')).rejects.toMatchObject({ status: 403, message: expect.stringContaining('AccessDenied') });
  });

  it('GCS uploads with a bearer token through the JSON API', async () => {
    const { calls, fetch } = recorder();
    await new GcsArchive({ bucket: 'bk', prefix: 'p', token: async () => 'tok', fetch }).put('a/b.gz', Buffer.from('x'), 'application/gzip');
    expect(calls[0]!.url).toBe('https://storage.googleapis.com/upload/storage/v1/b/bk/o?uploadType=media&name=p%2Fa%2Fb.gz');
    expect(calls[0]!.init.headers.authorization).toBe('Bearer tok');
  });

  it('Azure Shared Key string-to-sign follows the 2015-02-21+ layout', () => {
    const sts = sharedKeyStringToSign({ method: 'PUT', account: 'acct', path: '/c/blob', headers: { 'content-type': 'application/gzip', 'content-length': '0', 'x-ms-version': '2021-08-06', 'x-ms-date': 'D', 'x-ms-blob-type': 'BlockBlob' } });
    expect(sts).toBe('PUT\n\n\n\n\napplication/gzip\n\n\n\n\n\n\nx-ms-blob-type:BlockBlob\nx-ms-date:D\nx-ms-version:2021-08-06\n/acct/c/blob');
  });

  it('Azure PUTs a BlockBlob with SharedKey or SAS', async () => {
    const { calls, fetch } = recorder();
    await new AzureBlobArchive({ account: 'acct', container: 'c', prefix: 'p', auth: { sharedKey: Buffer.alloc(32).toString('base64') }, fetch }).put('k', Buffer.from('x'), 'application/gzip');
    expect(calls[0]!.url).toBe('https://acct.blob.core.windows.net/c/p/k');
    expect(calls[0]!.init.headers.authorization).toMatch(/^SharedKey acct:[A-Za-z0-9+/=]+$/);
    expect(calls[0]!.init.headers['x-ms-blob-type']).toBe('BlockBlob');
    await new AzureBlobArchive({ account: 'acct', container: 'c', prefix: '', auth: { sas: '?sv=1&sig=x' }, fetch }).put('k', Buffer.from('x'), 'text/plain');
    expect(calls[1]!.url).toBe('https://acct.blob.core.windows.net/c/k?sv=1&sig=x');
  });
});

describe('createArchiveStore (AUDIT_ARCHIVE_URL)', () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('parses every scheme with credentials from env only', () => {
    expect(createArchiveStore(undefined)).toBeNull();
    expect(createArchiveStore('file:./data/archive', {}, undefined, '/srv')).toMatchObject({ kind: 'local-fs', root: '/srv/data/archive' });
    expect(createArchiveStore('s3://bkt/pre?region=eu-central-1', { AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b' })).toMatchObject({ kind: 's3', location: 's3://bkt/pre' });
    expect(createArchiveStore('gs://bkt/pre', { GCS_HMAC_ACCESS_KEY_ID: 'a', GCS_HMAC_SECRET: 'b' })).toMatchObject({ kind: 'gcs' });
    expect(createArchiveStore('gs://bkt/pre', {})).toBeInstanceOf(GcsArchive);
    expect(createArchiveStore('azblob://acct/cont/pre', { AZURE_STORAGE_KEY: 'a2V5' })).toMatchObject({ kind: 'azure-blob', location: 'azblob://acct/cont/pre' });
    expect(() => createArchiveStore('s3://bkt', {})).toThrow(ArchiveConfigError);
    expect(() => createArchiveStore('s3://user:pw@bkt', { AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b' })).toThrow(/environment/);
    expect(() => createArchiveStore('ftp://x', {})).toThrow(/unsupported/);
  });

  it('local-fs writes atomically and refuses keys escaping the root', async () => {
    dir = await mkdtemp(join(tmpdir(), 'nr-archive-'));
    const fs = new LocalFsArchive(dir);
    await fs.put('audit/2026/11/24/a.json', Buffer.from('{}'));
    expect(await readFile(join(dir, 'audit/2026/11/24/a.json'), 'utf8')).toBe('{}');
    await expect(fs.put('../escape', Buffer.from('x'))).rejects.toThrow(/escapes/);
  });
});
