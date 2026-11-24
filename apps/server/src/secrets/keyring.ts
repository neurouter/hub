import { open, seal } from './envelope.js';

/**
 * Key-encryption keys (KEKs) from `NEUROUTER_MASTER_KEYS`. Never stored in the DB.
 * A future KMS-backed keyring implements the same interface (backend §8).
 */
export interface Keyring {
  readonly activeKekId: string;
  has(kekId: string): boolean;
  wrap(dekId: string, dek: Buffer): { kekId: string; wrapped: Buffer };
  unwrap(dekId: string, kekId: string, wrapped: Buffer): Buffer;
  /** Raw active KEK, for HKDF-derived subkeys (MRTR state, audit MAC). */
  derivationKey(kekId?: string): Buffer;
}

export const dekAad = (dekId: string) => `neurouter:dek:${dekId}`;

export class EnvKeyring implements Keyring {
  constructor(
    private readonly keys: ReadonlyMap<string, Buffer>,
    readonly activeKekId: string,
  ) {
    if (!keys.has(activeKekId)) throw new Error(`Active key id "${activeKekId}" is not configured`);
  }

  has(kekId: string): boolean {
    return this.keys.has(kekId);
  }

  private key(kekId: string): Buffer {
    const k = this.keys.get(kekId);
    if (!k) throw new Error(`KEK "${kekId}" is not configured (add it back to NEUROUTER_MASTER_KEYS)`);
    return k;
  }

  wrap(dekId: string, dek: Buffer): { kekId: string; wrapped: Buffer } {
    const s = seal(this.key(this.activeKekId), dek, dekAad(dekId));
    return { kekId: this.activeKekId, wrapped: Buffer.concat([s.nonce, s.ciphertext]) };
  }

  unwrap(dekId: string, kekId: string, wrapped: Buffer): Buffer {
    return open(this.key(kekId), { nonce: wrapped.subarray(0, 12), ciphertext: wrapped.subarray(12) }, dekAad(dekId));
  }

  derivationKey(kekId = this.activeKekId): Buffer {
    return this.key(kekId);
  }
}
