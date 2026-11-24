import { randomBytes } from 'node:crypto';
import { hmacSha256, randomToken, timingSafeEqualBuf } from '../lib/crypto.js';

/** `nr_live_<key_id>_<secret>` (backend §7.3). key_id: 10 chars Crockford base32; secret: 32 random bytes base62. */
export const API_KEY_PREFIX = 'nr_live_';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const KEY_ID_RE = /^[0-9A-HJKMNP-TV-Z]{10}$/;
const SECRET_RE = /^[0-9A-Za-z]{40,64}$/;

export function generateKeyId(): string {
  let out = '';
  for (const b of randomBytes(10)) out += CROCKFORD[b & 31];
  return out;
}

export interface GeneratedApiKey {
  keyId: string;
  secret: string;
  /** The full value shown once to the user. */
  token: string;
  displayPrefix: string;
}

export function generateApiKey(): GeneratedApiKey {
  const keyId = generateKeyId();
  const secret = randomToken(32);
  return { keyId, secret, token: `${API_KEY_PREFIX}${keyId}_${secret}`, displayPrefix: `${API_KEY_PREFIX}${keyId}` };
}

export function parseApiKey(token: string): { keyId: string; secret: string } | null {
  if (!token.startsWith(API_KEY_PREFIX)) return null;
  const rest = token.slice(API_KEY_PREFIX.length);
  const i = rest.indexOf('_');
  if (i !== 10) return null;
  const keyId = rest.slice(0, i);
  const secret = rest.slice(i + 1);
  if (!KEY_ID_RE.test(keyId) || !SECRET_RE.test(secret)) return null;
  return { keyId, secret };
}

/** HMAC-SHA256(HASH_PEPPER, secret); independent of KEK rotation. */
export function hashSecret(pepper: string, secret: string): Buffer {
  return hmacSha256(pepper, secret);
}

export function verifySecret(pepper: string, secret: string, expected: Buffer): boolean {
  return timingSafeEqualBuf(hashSecret(pepper, secret), expected);
}
