import type { ToolRow } from '@neurouter/shared';

/**
 * What the gateway actually does with calls to a tool. `enabled` is only the admin's switch: the
 * gateway also blocks any tool whose definition is not approved (pending review after an upstream
 * change, or rejected) and tools the upstream no longer lists (server `policy/acl.ts`, status !==
 * 'active'). Showing `enabled` alone made a changed tool look live while every call was refused.
 */
export type EffectiveToolState = 'enabled' | 'disabled' | 'blocked_review' | 'blocked_rejected' | 'removed';

export function effectiveToolState(t: Pick<ToolRow, 'enabled' | 'reviewState' | 'upstreamPresent'>): EffectiveToolState {
  if (!t.upstreamPresent) return 'removed';
  if (t.reviewState === 'pending_review') return 'blocked_review';
  if (t.reviewState === 'rejected') return 'blocked_rejected';
  return t.enabled ? 'enabled' : 'disabled';
}

export const EFFECTIVE_STATE_LABEL: Record<EffectiveToolState, { label: string; tone: 'ok' | 'warn' | 'err' | 'muted'; hint: string }> = {
  enabled: { label: 'Enabled', tone: 'ok', hint: 'Calls are allowed, subject to grants, approvals and rate limits.' },
  disabled: { label: 'Disabled', tone: 'muted', hint: 'Hidden from search; calls are blocked.' },
  blocked_review: { label: 'Blocked until reviewed', tone: 'warn', hint: 'The upstream definition changed. Calls are blocked until someone approves the new definition.' },
  blocked_rejected: { label: 'Blocked: definition rejected', tone: 'err', hint: 'The current upstream definition was rejected. Calls stay blocked until a new definition is approved.' },
  removed: { label: 'Removed upstream', tone: 'muted', hint: 'The upstream server no longer lists this tool.' },
};
