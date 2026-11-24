/**
 * Key helper: `npm run keys -- gen` prints fresh values for NEUROUTER_MASTER_KEYS,
 * NEUROUTER_ACTIVE_KEY_ID and HASH_PEPPER to paste into your .env (never commit them).
 * Rotation and offline audit verification are added with steps 3 and 5.
 */
import { randomBytes } from 'node:crypto';

export function generateKeyEnv(keyId = 'k1'): string {
  return [
    `NEUROUTER_MASTER_KEYS=${keyId}:${randomBytes(32).toString('base64')}`,
    `NEUROUTER_ACTIVE_KEY_ID=${keyId}`,
    `HASH_PEPPER=${randomBytes(48).toString('base64url')}`,
  ].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, keyId] = process.argv.slice(2);
  if (cmd === 'gen') {
    console.log(generateKeyEnv(keyId));
  } else {
    console.error('Usage: npm run keys -- gen [keyId]');
    process.exit(2);
  }
}
