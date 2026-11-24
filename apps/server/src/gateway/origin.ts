/**
 * Origin check for `/mcp` (backend §5.1 step 1, spec DNS-rebinding guidance): an absent Origin
 * is allowed (non-browser clients); a present one must be the gateway's own origin or listed in
 * MCP_ALLOWED_ORIGINS.
 */
export function originAllowed(origin: string | undefined, publicUrl: string, allowed: readonly string[]): boolean {
  if (origin === undefined || origin === '') return true;
  let o: string;
  try {
    o = new URL(origin).origin;
  } catch {
    return false;
  }
  if (o === new URL(publicUrl).origin) return true;
  return allowed.some((a) => {
    try {
      return new URL(a).origin === o;
    } catch {
      return false;
    }
  });
}
