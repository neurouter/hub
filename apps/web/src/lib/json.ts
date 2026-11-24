/** Deep copy with object keys sorted (arrays keep their order), so key-order changes aren't diff noise. */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) out[k] = sortKeysDeep((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}

/** Pretty JSON with sorted keys (2-space indent). `null`/`undefined` → "". */
export function stableStringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  return JSON.stringify(sortKeysDeep(value), null, 2);
}
