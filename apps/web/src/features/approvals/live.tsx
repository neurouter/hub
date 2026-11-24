import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { APPROVAL_STREAM_EVENTS, api, type Approval, type ApprovalStreamEvent } from '@neurouter/shared';
import { createLiveChannel, type LiveStatus, type LiveTransport, liveTransport } from '@/lib/live';
import { applyApprovalEvent, approvalKeys } from './model';

type Listener = (type: ApprovalStreamEvent, a: Approval) => void;

interface ApprovalsLive {
  status: LiveStatus;
  subscribe: (fn: Listener) => () => void;
}

const Ctx = createContext<ApprovalsLive>({ status: 'closed', subscribe: () => () => {} });

/**
 * One approvals SSE channel per signed-in reviewer, mounted in the app shell so the sidebar badge is
 * live on every page (§6.4). Events update the query cache; pages subscribe for side effects
 * (announcements). When the channel is degraded, pages poll instead.
 */
export function ApprovalsLiveProvider({ enabled, children, transport = liveTransport }: { enabled: boolean; children: ReactNode; transport?: LiveTransport }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>('closed');
  const listeners = useRef(new Set<Listener>());
  const [value] = useState(() => ({
    subscribe: (fn: Listener) => {
      listeners.current.add(fn);
      return () => void listeners.current.delete(fn);
    },
  }));

  useEffect(() => {
    if (!enabled) return;
    const ch = createLiveChannel(
      api.approvals.stream.path,
      {
        events: APPROVAL_STREAM_EVENTS,
        onEvent: (type, data) => {
          const a = applyApprovalEvent(qc, type as ApprovalStreamEvent, data);
          if (a) for (const fn of listeners.current) fn(type as ApprovalStreamEvent, a);
        },
        onStatus: setStatus,
        onResume: () => void qc.invalidateQueries({ queryKey: approvalKeys.all }),
      },
      transport,
    );
    return () => ch.close();
  }, [enabled, qc, transport]);

  return <Ctx.Provider value={{ status: enabled ? status : 'closed', subscribe: value.subscribe }}>{children}</Ctx.Provider>;
}

export function useApprovalsLive(): ApprovalsLive {
  return useContext(Ctx);
}

/** Subscribe to approval events while mounted. */
export function useApprovalEvents(fn: Listener): void {
  const { subscribe } = useApprovalsLive();
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  useEffect(() => subscribe((t, a) => ref.current(t, a)), [subscribe]);
}
