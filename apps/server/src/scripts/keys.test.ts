import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/load.js';
import { generateKeyEnv } from './keys.js';

describe('keys gen', () => {
  it('produces values the config loader accepts', () => {
    const env = Object.fromEntries(generateKeyEnv('k7').split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2) as [string, string]));
    const c = loadConfig({ NODE_ENV: 'development', ...env });
    expect(c.activeKeyId).toBe('k7');
    expect(c.masterKeys.get('k7')?.length).toBe(32);
    expect(c.hashPepper.length).toBeGreaterThanOrEqual(32);
    expect(c.warnings).toEqual([]);
  });
});
