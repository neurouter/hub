import type { Kysely } from 'kysely';
import type { CoordinationStore, Json } from '../../coordination/types.js';
import type { MainDB } from '../../db/schema.js';
import type { ApprovalGate, ApprovalHoldInput, ApprovalOutcome } from '../../gateway/approval-gate.js';
import type { RequestContext } from '../../gateway/context.js';
import type { Clock } from '../../lib/clock.js';
import { newId } from '../../lib/ids.js';
import { hashCanonical } from '../../lib/jcs.js';
import { toJsonColumn } from '../../lib/json.js';
import type { SettingsService } from '../../settings/settings.service.js';
import { APPROVALS_CHANGED, approvalChannel, type ApprovalSignal, type ApprovalsService } from './approvals.service.js';

export interface ApprovalHoldDeps {
  db: Kysely<MainDB>;
  clock: Clock;
  coord: CoordinationStore;
  settings: SettingsService;
  approvals: ApprovalsService;
  instanceId: string;
  /** Redacts arguments for the approver's view (audit redaction rules). */
  redact: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  onWait?: (outcome: string, seconds: number) => void;
  heartbeatMs?: number;
  progressMs?: number;
  pollMs?: number;
}

const minutes = (sec: number) => (sec % 60 === 0 ? `${sec / 60}m` : sec >= 60 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${sec}s`);

/**
 * Cross-replica approval hold (backend §12.2). Inserts a pending row with frozen redacted
 * arguments and their hash, heart-beats every 15 s, sends progress every 10 s, and waits on
 * `approval:<id>` with a DB poll as the correctness fallback (NOTIFY only cuts latency). A
 * client abort cancels; the timeout expires. The in-memory `args` (whose hash is stored) are
 * the ones executed, so nothing else can be substituted; if this replica dies the janitor marks
 * the row abandoned and nothing runs.
 */
export class ApprovalHold implements ApprovalGate {
  constructor(private readonly d: ApprovalHoldDeps) {}

  async hold(rc: RequestContext, input: ApprovalHoldInput): Promise<ApprovalOutcome> {
    const { db, clock, settings } = this.d;
    const [def, max] = await Promise.all([settings.get('approvalDefaultTimeoutSec'), settings.get('approvalMaxTimeoutSec')]);
    const timeoutSec = Math.max(1, Math.min(input.timeoutSec ?? def, max));
    const id = newId();
    const now = clock.now();
    const expiresAt = now + timeoutSec * 1000;
    const p = rc.principal;
    await db
      .insertInto('approvals')
      .values({
        id,
        tool_id: input.toolId,
        server_id: input.serverId,
        agent_id: p.agent.id,
        user_id: p.user.id,
        audit_request_id: input.requestId,
        arguments_redacted: toJsonColumn(await this.d.redact(input.args)),
        arguments_hash: hashCanonical(input.args),
        status: 'pending',
        held_by_instance: this.d.instanceId,
        heartbeat_at: now,
        expires_at: expiresAt,
        decided_by: null,
        decided_at: null,
        reason: null,
        client_name: input.client?.name ?? null,
        client_version: input.client?.version ?? null,
        auth_method: p.authMethod,
        api_key_id: p.authMethod === 'api_key' ? p.credentialId : null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    input.onPending?.({ id, expiresAt, timeoutSec });
    await this.d.coord.publish(APPROVALS_CHANGED, { id, status: 'pending' });

    const timers: NodeJS.Timeout[] = [];
    timers.push(
      setInterval(() => {
        void db.updateTable('approvals').set({ heartbeat_at: clock.now() }).where('id', '=', id).where('status', '=', 'pending').execute().catch(() => {});
      }, this.d.heartbeatMs ?? 15_000),
    );
    if (input.progress) {
      const progress = input.progress;
      const message = `Waiting for human approval (id ${id}); times out in ${minutes(timeoutSec)}`;
      progress({ progress: 0, total: timeoutSec, message });
      timers.push(setInterval(() => progress({ progress: Math.min(timeoutSec, Math.round((clock.now() - now) / 1000)), total: timeoutSec, message }), this.d.progressMs ?? 10_000));
    }
    const started = Date.now();
    const finish = (outcome: string) => this.d.onWait?.(outcome, (Date.now() - started) / 1000);
    try {
      let signal: ApprovalSignal | null;
      try {
        signal = (await this.d.coord.waitFor(approvalChannel(id), (x) => (x as unknown as ApprovalSignal).status !== 'pending', {
          timeoutMs: expiresAt - clock.now(),
          signal: input.signal,
          pollEveryMs: this.d.pollMs ?? 2000,
          poll: async () => {
            const r = await db.selectFrom('approvals').select(['status', 'decided_by', 'reason']).where('id', '=', id).executeTakeFirst();
            return r ? ({ status: r.status, decidedBy: r.decided_by, reason: r.reason } satisfies ApprovalSignal as unknown as Json) : null;
          },
        })) as ApprovalSignal | null;
      } catch {
        // client went away: nothing will run
        await this.d.approvals.transition(id, 'cancelled');
        finish('cancelled');
        return { status: 'cancelled', message: 'The client cancelled the request while it was waiting for approval', approvalId: id };
      }
      if (!signal) {
        // timed out here; a decision may have landed at the last moment, so CAS and re-read
        const changed = await this.d.approvals.transition(id, 'expired');
        if (!changed) {
          const r = await db.selectFrom('approvals').select(['status', 'decided_by', 'reason']).where('id', '=', id).executeTakeFirst();
          signal = r ? { status: r.status, decidedBy: r.decided_by, reason: r.reason } : null;
        }
        if (!signal || signal.status === 'expired' || signal.status === 'pending') {
          finish('timeout');
          return { status: 'timeout', message: `Approval timed out after ${minutes(timeoutSec)}; nobody approved the call to ${input.toolName}`, approvalId: id };
        }
      }
      return await this.outcome(id, signal, input.toolName, finish);
    } finally {
      for (const t of timers) clearInterval(t);
    }
  }

  private async outcome(id: string, s: ApprovalSignal, toolName: string, finish: (o: string) => void): Promise<ApprovalOutcome> {
    switch (s.status) {
      case 'approved':
        finish('approved');
        return { status: 'approved', approverId: s.decidedBy ?? '', approvalId: id };
      case 'denied': {
        const who = s.decidedBy ? await this.d.db.selectFrom('users').select('name').where('id', '=', s.decidedBy).executeTakeFirst() : null;
        finish('denied');
        return { status: 'denied', message: `Denied by ${who?.name ?? 'an approver'}: ${s.reason ?? 'no reason given'}`, approvalId: id };
      }
      case 'expired':
        finish('timeout');
        return { status: 'timeout', message: `Approval for ${toolName} expired before anyone decided`, approvalId: id };
      default:
        finish('cancelled');
        return { status: 'cancelled', message: `The approval was ${s.status}`, approvalId: id };
    }
  }
}
