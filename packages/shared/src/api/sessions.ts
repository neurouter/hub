import * as z from 'zod';
import { AuditDecision, AuditStatus, SessionSource } from '../domain/enums.js';
import { CursorQuery, Id, IdParams, IsoDateTime, IsoDateTimeInput, Page, QueryBool, Ref, ServerRef, queryOptional } from './common.js';
import { endpoint } from './endpoint.js';

export const Session = z.object({
  id: Id,
  source: SessionSource,
  agent: Ref,
  user: Ref,
  client: z.object({ name: z.string() }).nullable(),
  startedAt: IsoDateTime,
  lastActivityAt: IsoDateTime,
  callCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  blockedCount: z.number().int().nonnegative(),
  /** lastActivityAt > now − 5 min */
  active: z.boolean(),
});
export type Session = z.infer<typeof Session>;

export const SessionDetail = Session.extend({
  perMinute: z.array(z.object({ t: IsoDateTime, calls: z.number().int().nonnegative() })),
});
export type SessionDetail = z.infer<typeof SessionDetail>;

export const SessionEvent = z.object({
  auditEventId: Id,
  ts: IsoDateTime,
  server: ServerRef,
  tool: z.object({ qualifiedName: z.string() }),
  decision: AuditDecision,
  status: AuditStatus,
  latencyMs: z.number().int().nonnegative().nullable(),
});
export type SessionEvent = z.infer<typeof SessionEvent>;

export const ListSessionsQuery = CursorQuery.extend({
  from: IsoDateTimeInput,
  to: IsoDateTimeInput,
  agentId: queryOptional(Id),
  userId: queryOptional(Id),
  active: queryOptional(QueryBool),
});
export type ListSessionsQuery = z.infer<typeof ListSessionsQuery>;

export const sessionEndpoints = {
  list: endpoint({
    method: 'GET', path: '/api/sessions', kind: 'json', access: ['auditor', 'owner', 'user'],
    summary: 'Sessions', query: ListSessionsQuery, response: Page(Session),
  }),
  get: endpoint({
    method: 'GET', path: '/api/sessions/:id', kind: 'json', access: ['auditor', 'owner', 'user'],
    summary: 'Session summary', params: IdParams, response: SessionDetail,
  }),
  events: endpoint({
    method: 'GET', path: '/api/sessions/:id/events', kind: 'json', access: ['auditor', 'owner', 'user'],
    summary: 'Session timeline', params: IdParams, query: CursorQuery, response: Page(SessionEvent),
  }),
} as const;
