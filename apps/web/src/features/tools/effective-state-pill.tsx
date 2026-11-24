import type { ToolRow } from '@neurouter/shared';
import { Pill } from '@/components/status/status';
import { EFFECTIVE_STATE_LABEL, effectiveToolState } from './effective-state';

/** The tool's effective state (not just its switch); see effective-state.ts. */
export function EffectiveStatePill({ tool }: { tool: Pick<ToolRow, 'enabled' | 'reviewState' | 'upstreamPresent'> }) {
  const s = EFFECTIVE_STATE_LABEL[effectiveToolState(tool)];
  return (
    <Pill tone={s.tone} title={s.hint}>
      {s.label}
    </Pill>
  );
}
