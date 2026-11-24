import { describe, expect, it } from 'vitest';
import { effectiveToolState } from './effective-state';

describe('effectiveToolState', () => {
  it('blocks a tool whose definition changed even while its switch is on', () => {
    expect(effectiveToolState({ enabled: true, reviewState: 'pending_review', upstreamPresent: true })).toBe('blocked_review');
  });
  it('reports rejected and removed tools as blocked regardless of the switch', () => {
    expect(effectiveToolState({ enabled: true, reviewState: 'rejected', upstreamPresent: true })).toBe('blocked_rejected');
    expect(effectiveToolState({ enabled: true, reviewState: 'approved', upstreamPresent: false })).toBe('removed');
  });
  it('follows the switch for approved tools', () => {
    expect(effectiveToolState({ enabled: true, reviewState: 'approved', upstreamPresent: true })).toBe('enabled');
    expect(effectiveToolState({ enabled: false, reviewState: 'approved', upstreamPresent: true })).toBe('disabled');
  });
});
