/** "Dana Whitfield" → "DW"; falls back to the email's first letter. */
export function initials(name: string, email = ''): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (email[0] ?? '?').toUpperCase();
}

const AVATAR_COLORS = ['#6d28d9', '#0f766e', '#b45309', '#1d4ed8', '#be123c', '#4d7c0f', '#7c2d12', '#0e7490'];

/** Stable avatar background per user (prototype uses fixed hues on white initials). */
export function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
}
