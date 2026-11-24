import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** AES-256-GCM primitive (backend §8). `ciphertext` carries the 16-byte tag at its end. */
export interface Sealed {
  nonce: Buffer;
  ciphertext: Buffer;
}

const TAG_BYTES = 16;
export const NONCE_BYTES = 12;
export const KEY_BYTES = 32;

export function seal(key: Buffer, plaintext: Uint8Array, aad: string): Sealed {
  if (key.length !== KEY_BYTES) throw new Error('AES-256-GCM key must be 32 bytes');
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, ciphertext: Buffer.concat([body, cipher.getAuthTag()]) };
}

export class DecryptError extends Error {
  constructor(message = 'Decryption failed (wrong key, AAD mismatch or tampered ciphertext)') {
    super(message);
    this.name = 'DecryptError';
  }
}

export function open(key: Buffer, sealed: Sealed, aad: string): Buffer {
  if (key.length !== KEY_BYTES) throw new Error('AES-256-GCM key must be 32 bytes');
  if (sealed.nonce.length !== NONCE_BYTES || sealed.ciphertext.length < TAG_BYTES) throw new DecryptError('Malformed ciphertext');
  const body = sealed.ciphertext.subarray(0, sealed.ciphertext.length - TAG_BYTES);
  const tag = sealed.ciphertext.subarray(sealed.ciphertext.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.nonce);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new DecryptError();
  }
}

/** Packs nonce‖ciphertext into one blob (columns that hold a single encrypted value). */
export function pack(s: Sealed): Buffer {
  return Buffer.concat([s.nonce, s.ciphertext]);
}

export function unpack(blob: Buffer): Sealed {
  return { nonce: blob.subarray(0, NONCE_BYTES), ciphertext: blob.subarray(NONCE_BYTES) };
}
