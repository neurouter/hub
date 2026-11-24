import { buildExposedName, MAX_TOOL_NAME, TOOL_SEPARATOR } from '@neurouter/shared';
import { sha256 } from '../lib/crypto.js';

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Exposed tool name (backend §5.5): `<slug>__<upstream>` when that satisfies the spec SHOULDs
 * (`[A-Za-z0-9_.-]`, ≤128 chars); otherwise a stable alias
 * `<slug>__<sanitized prefix>_<6 base32 chars of sha256(upstream)>`.
 */
export function exposedNameFor(slug: string, upstreamName: string): { name: string; aliased: boolean } {
  const direct = buildExposedName(slug, upstreamName);
  if (direct) return { name: direct, aliased: false };
  const suffix = `_${base32(sha256(upstreamName)).slice(0, 6)}`;
  const room = MAX_TOOL_NAME - slug.length - TOOL_SEPARATOR.length - suffix.length;
  const sanitized = upstreamName.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, Math.max(1, room));
  return { name: `${slug}${TOOL_SEPARATOR}${sanitized}${suffix}`, aliased: true };
}
