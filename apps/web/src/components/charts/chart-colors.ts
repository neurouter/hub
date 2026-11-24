import type { ChartConfig } from '@/components/ui/chart';

/**
 * Colour-blind-safe chart mapping from the approved prototype (frontend addendum #2):
 * success = blue (chart-1), error = red (destructive), and "blocked" lives in its own chart
 * (amber, chart-3), never stacked with success/error. Latency percentiles use chart-1..3 and
 * also differ by dash pattern so colour is not the only cue (§7).
 */
export const SERIES_COLOR = {
  success: 'var(--chart-1)',
  error: 'var(--destructive)',
  blocked: 'var(--chart-3)',
  p50: 'var(--chart-1)',
  p95: 'var(--chart-2)',
  p99: 'var(--chart-3)',
} as const;

export const LATENCY_DASH = { p50: undefined, p95: '6 3', p99: '2 3' } as const;

export const callsChartConfig = {
  success: { label: 'Success', color: SERIES_COLOR.success },
  errors: { label: 'Error', color: SERIES_COLOR.error },
} satisfies ChartConfig;

export const latencyChartConfig = {
  p50: { label: 'p50', color: SERIES_COLOR.p50 },
  p95: { label: 'p95', color: SERIES_COLOR.p95 },
  p99: { label: 'p99', color: SERIES_COLOR.p99 },
} satisfies ChartConfig;

/** Tokens every chart series uses; each must reach 3:1 against `--card` in both themes. */
export const CHART_SERIES_TOKENS = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--destructive'] as const;

/** Reads `--token: #hex;` declarations from one block (`:root` or `.dark`) of a stylesheet. */
export function readTokens(css: string, selector: ':root' | '.dark'): Record<string, string> {
  const start = css.search(new RegExp(`(^|\\n)${selector.replace('.', '\\.')}\\s*\\{`));
  if (start < 0) return {};
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const out: Record<string, string> = {};
  for (const m of css.slice(open + 1, close).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1] as string] = (m[2] as string).trim();
  return out;
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of `#rrggbb`. */
export function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two `#hex` colours (1–21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
