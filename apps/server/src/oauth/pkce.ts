import { createHash } from 'node:crypto';
import { timingSafeEqualStr } from '../lib/crypto.js';

/** RFC 7636 §4.1: 43–128 chars of [A-Z a-z 0-9 - . _ ~]. */
export const PKCE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
/** S256 challenge: base64url(SHA-256(verifier)) without padding = 43 chars. */
export const PKCE_CHALLENGE_RE = /^[A-Za-z0-9\-_]{43}$/;

export function s256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** Constant-time PKCE S256 check (plain is never accepted). */
export function verifyPkceS256(verifier: string | undefined, challenge: string): boolean {
  if (!verifier || !PKCE_VERIFIER_RE.test(verifier)) return false;
  return timingSafeEqualStr(s256(verifier), challenge);
}
