import canonicalize from 'canonicalize';
import { sha256Hex } from './crypto.js';

/** RFC 8785 JSON Canonicalization Scheme. */
export function canonicalJson(value: unknown): string {
  const s = canonicalize(value);
  if (s === undefined) throw new Error('Value cannot be canonicalized');
  return s;
}

/** sha256 hex of the canonical JSON (tool definition hashes, audit output hashes). */
export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
