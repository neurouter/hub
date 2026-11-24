/** Injected everywhere time matters so tests can use a fake clock. */
export interface Clock {
  /** epoch milliseconds */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

export function toIsoOrNull(ms: number | null | undefined): string | null {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

/** Parses an ISO-8601 timestamp to epoch ms; throws on invalid input. */
export function fromIso(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`Invalid timestamp: ${iso}`);
  return ms;
}
