import type { FastifyInstance } from 'fastify';
import { api, type MetricsFilterQuery } from '@neurouter/shared';
import type { Services } from '../../deps.js';
import { clientMeta, requireAdmin, requireCap, requireUser } from '../../auth/web/guards.js';
import { SinkDeliveryError } from '../../audit/sinks/sink.js';
import type { UserSubject } from '../../identity/principal.js';
import { timingSafeEqualStr } from '../../lib/crypto.js';
import { fromIso } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import type { MetricsFilter } from '../../observability/rollup-queries.js';
import { registerEndpoint } from '../routes.js';
import { resolveScope } from '../scope.js';

const MAX_METRICS_RANGE_MS = 400 * 86_400_000;

/** Scoped metrics filter: owners forced to owned servers, plain users to their own calls. */
export function metricsFilter(q: MetricsFilterQuery, viewer: UserSubject): MetricsFilter {
  const scope = resolveScope(viewer, 'metrics:read', q);
  const from = fromIso(q.from);
  const to = fromIso(q.to);
  if (to <= from) throw AppError.validation('`to` must be after `from`', [{ path: ['to'], message: 'Must be after from', code: 'invalid_range' }]);
  if (to - from > MAX_METRICS_RANGE_MS) throw AppError.validation('Time range too long', [{ path: ['to'], message: 'The range must not exceed 400 days', code: 'too_big' }]);
  const f: MetricsFilter = { from, to };
  if (scope.serverIds) f.serverIds = scope.serverIds;
  const userId = scope.userId ?? q.userId;
  if (userId) f.userId = userId;
  if (q.toolId) f.toolId = q.toolId;
  if (q.agentId) f.agentId = q.agentId;
  return f;
}

/** Steps 5–6 REST: audit, redaction rules, sink test, metrics, sessions; plus Prometheus /metrics. */
export async function observabilityRoutes(app: FastifyInstance, s: Services): Promise<void> {
  /* ---------------------------------------------------------------- audit */
  registerEndpoint(app, api.audit.events, async (req) => s.auditService.events(req.query, requireUser(req)));
  registerEndpoint(app, api.audit.event, async (req) => s.auditService.event(req.params.id, requireUser(req)));
  registerEndpoint(app, api.audit.export, async (req, reply) => {
    const user = requireCap(req, 'audit:export');
    await s.auditService.export(req.query, user, reply, clientMeta(req));
    return reply;
  });
  registerEndpoint(app, api.audit.verify, async (req) => s.auditService.verify(req.body, requireCap(req, 'audit:verify')));

  /* ---------------------------------------------------------------- redaction rules */
  registerEndpoint(app, api.redaction.list, async (req) => {
    requireCap(req, 'settings:read');
    return s.redactionRules.list();
  });
  registerEndpoint(app, api.redaction.create, async (req) => s.redactionRules.create(req.body, requireAdmin(req)));
  registerEndpoint(app, api.redaction.update, async (req) => s.redactionRules.update(req.params.id, req.body, requireAdmin(req)));
  registerEndpoint(app, api.redaction.delete, async (req) => s.redactionRules.delete(req.params.id, requireAdmin(req)));
  registerEndpoint(app, api.redaction.test, async (req) => {
    requireAdmin(req);
    return s.redactionRules.test(req.body);
  });

  /* ---------------------------------------------------------------- SIEM webhook test */
  registerEndpoint(app, api.settings.testExport, async (req) => {
    const user = requireAdmin(req);
    const cfg = await s.settings.get('auditSinks');
    if (!cfg.webhook.url) throw AppError.validation('No webhook URL configured', [{ path: ['export', 'webhookUrl'], message: 'Set a webhook URL first', code: 'required' }]);
    const sink = s.webhookSink(cfg.webhook.url, cfg.webhook.secretRef);
    const now = s.clock.now();
    const body = `${JSON.stringify({ type: 'test', id: `test-${now}`, ts: new Date(now).toISOString(), message: 'Neurouter Hub audit webhook test event' })}\n`;
    s.audit.admin({ actorUserId: user.id, action: 'settings.export.test', targetType: 'settings', targetId: 'export', ...clientMeta(req) });
    try {
      const r = await sink.post(body);
      return { ok: true, status: r.status, error: null };
    } catch (err) {
      return { ok: false, status: err instanceof SinkDeliveryError ? err.status : null, error: (err as Error).message.slice(0, 300) };
    }
  });

  /* ---------------------------------------------------------------- metrics + sessions */
  registerEndpoint(app, api.metrics.summary, async (req) => s.rollupQueries.summary(metricsFilter(req.query, requireUser(req))));
  registerEndpoint(app, api.metrics.timeseries, async (req) => s.rollupQueries.timeseries(metricsFilter(req.query, requireUser(req)), req.query.interval));
  registerEndpoint(app, api.metrics.breakdown, async (req) => s.rollupQueries.breakdown(metricsFilter(req.query, requireUser(req)), req.query.dimension, req.query.sort ?? 'calls', req.query.limit ?? 10));
  registerEndpoint(app, api.sessions.list, async (req) => s.sessionsService.list(req.query, requireUser(req)));
  registerEndpoint(app, api.sessions.get, async (req) => s.sessionsService.get(req.params.id, requireUser(req)));
  registerEndpoint(app, api.sessions.events, async (req) => s.sessionsService.events(req.params.id, req.query, requireUser(req)));

  /* ---------------------------------------------------------------- Prometheus */
  if (s.config.env.METRICS_ENABLED) {
    const token = s.config.env.METRICS_TOKEN;
    app.get('/metrics', { logLevel: 'warn' }, async (req, reply) => {
      if (token) {
        const h = req.headers.authorization ?? '';
        const given = h.startsWith('Bearer ') ? h.slice(7) : '';
        if (!given || !timingSafeEqualStr(given, token)) return reply.status(401).header('www-authenticate', 'Bearer realm="metrics"').type('text/plain').send('unauthorized\n');
      }
      const m = await s.metrics.render();
      return reply.header('cache-control', 'no-store').type(m.contentType).send(m.body);
    });
  }
}
