import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CHART_SERIES_TOKENS, SERIES_COLOR, contrastRatio, readTokens } from './chart-colors';
import { computeDelta } from './kpi-card';

const css = readFileSync(resolve(import.meta.dirname, '../../styles/globals.css'), 'utf8');

describe('chart colours', () => {
  it('maps success to blue (chart-1), error to destructive and blocked to its own colour (addendum #2)', () => {
    expect(SERIES_COLOR.success).toBe('var(--chart-1)');
    expect(SERIES_COLOR.error).toBe('var(--destructive)');
    expect(SERIES_COLOR.blocked).not.toBe(SERIES_COLOR.success);
    expect(SERIES_COLOR.blocked).not.toBe(SERIES_COLOR.error);
  });

  it.each([':root', '.dark'] as const)('every series colour has ≥ 3:1 contrast against --card in %s', (block) => {
    const tokens = readTokens(css, block);
    expect(tokens['--card']).toMatch(/^#/);
    for (const t of CHART_SERIES_TOKENS) {
      const ratio = contrastRatio(tokens[t]!, tokens['--card']!);
      expect(ratio, `${t} in ${block}: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('computes WCAG contrast', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrastRatio('#ffffff', '#ffffff')).toBe(1);
  });
});

describe('KPI deltas', () => {
  it('colours by good/bad semantics, not direction', () => {
    expect(computeDelta(110, 100, 'neutral')).toEqual({ text: '10.0%', direction: 'up', tone: 'neutral' });
    expect(computeDelta(0.99, 0.98, 'higher-is-better', 'rate')).toMatchObject({ text: '1.0 pt', direction: 'up', tone: 'good' });
    expect(computeDelta(0.0129, 0.0159, 'lower-is-better', 'rate')).toMatchObject({ direction: 'down', tone: 'good' });
    expect(computeDelta(1942, 1605, 'lower-is-better')).toMatchObject({ direction: 'up', tone: 'bad' });
    expect(computeDelta(5, null, 'neutral')).toBeNull();
    expect(computeDelta(5, 0, 'neutral')).toBeNull();
    expect(computeDelta(0, 0, 'neutral')).toMatchObject({ direction: 'flat' });
  });
});
