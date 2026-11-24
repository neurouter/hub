import type { Settings, UpdateSettingsBody } from '@neurouter/shared';
import type { AuditRecorder } from '../audit/recorder.js';
import { AppError } from '../lib/errors.js';
import { assertUrlAllowed, SsrfError, type NetPolicy } from '../lib/net/ssrf-guard.js';
import type { SecretProvider } from '../secrets/provider.js';
import type { SettingsService } from './settings.service.js';

/** Maps the flat `settings` keys (backend §3.3) to the grouped REST `Settings` object (§14.2). */
export class SettingsApi {
  constructor(
    private readonly settings: SettingsService,
    private readonly secrets: SecretProvider,
    private readonly audit: AuditRecorder,
    private readonly env: { otlpEndpoint: string | null; outboundPolicy: NetPolicy },
  ) {}

  async get(): Promise<Settings> {
    const s = this.settings;
    const [auditDays, fullOutput, metrics, appDef, appMax, selfApproval, idle, rl, vis, dcr, cimd, sinks] = await Promise.all([
      s.get('auditRetentionDays'),
      s.get('auditStoreFullOutput'),
      s.get('metricsRetention'),
      s.get('approvalDefaultTimeoutSec'),
      s.get('approvalMaxTimeoutSec'),
      s.get('allowSelfApproval'),
      s.get('sessionIdleMinutes'),
      s.get('rateLimitDefaults'),
      s.get('catalogVisibility'),
      s.get('dcrEnabled'),
      s.get('cimdPolicy'),
      s.get('auditSinks'),
    ]);
    return {
      retention: { auditDays, metricsDays: metrics.hourDays, storeFullOutput: fullOutput },
      approvals: { timeoutMinutes: Math.round(appDef / 60), maxTimeoutMinutes: Math.round(appMax / 60), allowSelfApproval: selfApproval },
      sessions: { idleMinutes: idle },
      rateLimits: { agent: { perMinute: rl.agentPerMinute, burst: rl.agentBurst }, tool: { perMinute: rl.agentToolPerMinute, burst: rl.agentToolBurst } },
      catalogVisibility: vis,
      oauth: { dcrEnabled: dcr, cimdPolicy: cimd },
      export: {
        webhookUrl: sinks.webhook.url,
        hasWebhookSecret: sinks.webhook.secretRef !== null,
        webhookEnabled: sinks.webhook.enabled,
        otlpEndpoint: this.env.otlpEndpoint,
        otlpLogsEnabled: sinks.otelLogs.enabled,
        source: 'db',
      },
    };
  }

  async update(body: UpdateSettingsBody, actorId: string): Promise<Settings> {
    const before = await this.get();
    const s = this.settings;
    const a = body.approvals;
    const def = a?.timeoutMinutes ?? before.approvals.timeoutMinutes;
    const max = a?.maxTimeoutMinutes ?? before.approvals.maxTimeoutMinutes;
    if (def > max) throw AppError.validation('The default approval timeout cannot exceed the maximum', [{ path: ['approvals', 'timeoutMinutes'], message: 'Must be ≤ maxTimeoutMinutes', code: 'too_big' }]);
    if (body.export?.webhookUrl) {
      try {
        assertUrlAllowed(body.export.webhookUrl, this.env.outboundPolicy);
      } catch (err) {
        if (err instanceof SsrfError) throw AppError.validation('Webhook URL not allowed', [{ path: ['export', 'webhookUrl'], message: err.message, code: 'url_not_allowed' }]);
        throw err;
      }
    }
    if (body.retention) {
      if (body.retention.auditDays !== undefined) await s.set('auditRetentionDays', body.retention.auditDays, actorId);
      if (body.retention.storeFullOutput !== undefined) await s.set('auditStoreFullOutput', body.retention.storeFullOutput, actorId);
      if (body.retention.metricsDays !== undefined) await s.set('metricsRetention', { ...(await s.get('metricsRetention')), hourDays: body.retention.metricsDays }, actorId);
    }
    if (a) {
      if (a.timeoutMinutes !== undefined) await s.set('approvalDefaultTimeoutSec', a.timeoutMinutes * 60, actorId);
      if (a.maxTimeoutMinutes !== undefined) await s.set('approvalMaxTimeoutSec', a.maxTimeoutMinutes * 60, actorId);
      if (a.allowSelfApproval !== undefined) await s.set('allowSelfApproval', a.allowSelfApproval, actorId);
    }
    if (body.sessions?.idleMinutes !== undefined) await s.set('sessionIdleMinutes', body.sessions.idleMinutes, actorId);
    if (body.rateLimits) {
      const cur = await s.get('rateLimitDefaults');
      await s.set(
        'rateLimitDefaults',
        {
          ...cur,
          agentPerMinute: body.rateLimits.agent?.perMinute ?? cur.agentPerMinute,
          agentBurst: body.rateLimits.agent?.burst ?? cur.agentBurst,
          agentToolPerMinute: body.rateLimits.tool?.perMinute ?? cur.agentToolPerMinute,
          agentToolBurst: body.rateLimits.tool?.burst ?? cur.agentToolBurst,
        },
        actorId,
      );
    }
    if (body.catalogVisibility) await s.set('catalogVisibility', body.catalogVisibility, actorId);
    if (body.oauth?.dcrEnabled !== undefined) await s.set('dcrEnabled', body.oauth.dcrEnabled, actorId);
    if (body.oauth?.cimdPolicy) await s.set('cimdPolicy', { ...(await s.get('cimdPolicy')), ...body.oauth.cimdPolicy }, actorId);
    if (body.export) {
      const cur = await s.get('auditSinks');
      let secretRef = cur.webhook.secretRef;
      if (body.export.webhookSecret !== undefined) secretRef = (await this.secrets.put({ purpose: 'webhook_secret', value: Buffer.from(body.export.webhookSecret), ...(secretRef ? { id: secretRef } : {}) })).id;
      await s.set(
        'auditSinks',
        {
          webhook: { url: body.export.webhookUrl === undefined ? cur.webhook.url : body.export.webhookUrl, secretRef, enabled: body.export.webhookEnabled ?? cur.webhook.enabled },
          otelLogs: { enabled: body.export.otlpLogsEnabled ?? cur.otelLogs.enabled },
        },
        actorId,
      );
    }
    const after = await this.get();
    this.audit.admin({ actorUserId: actorId, action: 'settings.update', targetType: 'settings', targetId: 'gateway', before, after });
    return after;
  }
}
