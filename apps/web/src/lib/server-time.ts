/**
 * Server clock offset (frontend §5.2 "Countdown correctness", R5). `/api/me.serverTime` minus the
 * local time at receipt gives the offset; countdowns use `Date.now() + offset` so a skewed laptop
 * clock does not shorten or lengthen the approval window. The server stays the authority on expiry.
 */
let offsetMs = 0;

/** Offset in ms between the server clock and the local clock (`server - local`). */
export function computeOffset(serverTimeIso: string, receivedAtMs: number): number {
  const t = Date.parse(serverTimeIso);
  return Number.isFinite(t) ? t - receivedAtMs : 0;
}

export const serverClock = {
  /** Record `/api/me.serverTime` (called on every me fetch). */
  sync(serverTimeIso: string, receivedAtMs: number = Date.now()): void {
    offsetMs = computeOffset(serverTimeIso, receivedAtMs);
  },
  offset(): number {
    return offsetMs;
  },
  /** Server "now" for a given local time. */
  now(localNowMs: number = Date.now()): number {
    return localNowMs + offsetMs;
  },
  reset(): void {
    offsetMs = 0;
  },
};
