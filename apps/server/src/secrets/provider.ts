/** Reference to a stored secret value (row in `secrets`). */
export interface SecretRef {
  id: string;
}

/** Pluggable secret store (builtin now; aws_sm / gcp_sm / vault later, backend §8). */
export interface SecretProvider {
  readonly kind: 'builtin' | 'aws_sm' | 'gcp_sm' | 'vault';
  put(input: { purpose: string; value: Uint8Array; id?: string }): Promise<SecretRef>;
  get(ref: SecretRef): Promise<Buffer>;
  delete(ref: SecretRef): Promise<void>;
  updatedAt(ref: SecretRef): Promise<number | null>;
}
