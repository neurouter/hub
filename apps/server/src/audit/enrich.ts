import type { Kysely } from 'kysely';
import type { MainDB } from '../db/schema.js';
import type { AuditEventInput } from './types.js';

/**
 * Fills `server_id` on admin events about server-scoped resources (tools, access requests,
 * approvals, grants) so owner-scoped audit queries include them (§14.1: "admin rows only when
 * the target is an owned server, or a tool or grant of one"). Runs before the write transaction
 * against the control-plane DB; grants carry their server in the change body (a deleted grant
 * row can't be looked up any more).
 */
export function adminServerEnricher(db: Kysely<MainDB>) {
  return async (events: AuditEventInput[]): Promise<void> => {
    const need = events.filter((e) => e.kind === 'admin' && !e.serverId && e.targetId);
    if (!need.length) return;
    const ids = (type: string) => [...new Set(need.filter((e) => e.targetType === type).map((e) => e.targetId!))];
    const [tools, requests, approvals] = await Promise.all([
      ids('tool').length ? db.selectFrom('tools').select(['id', 'server_id']).where('id', 'in', ids('tool')).execute() : [],
      ids('access_request').length ? db.selectFrom('access_requests').select(['id', 'server_id']).where('id', 'in', ids('access_request')).execute() : [],
      ids('approval').length ? db.selectFrom('approvals').select(['id', 'server_id']).where('id', 'in', ids('approval')).execute() : [],
    ]);
    const map = new Map<string, string>();
    for (const r of [...tools, ...requests, ...approvals]) map.set(r.id, r.server_id);
    for (const e of need) {
      if (e.targetType === 'grant') {
        const g = (e.changes?.after ?? e.changes?.before) as { target?: { server?: { id?: unknown } } } | null | undefined;
        const sid = g?.target?.server?.id;
        if (typeof sid === 'string' && sid) e.serverId = sid;
        continue;
      }
      const sid = map.get(e.targetId!);
      if (sid) e.serverId = sid;
    }
  };
}
