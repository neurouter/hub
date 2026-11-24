import * as z from 'zod';
import { Role } from '../domain/roles.js';
import { endpoint } from './endpoint.js';

const RateLimitPair = z.object({ perMinute: z.number().int().positive(), burst: z.number().int().positive() });

/**
 * Gateway settings as grouped for the UI (backend §3.3 / §14.2). Per frontend addendum #1 there is
 * no tool exposure setting in Phase 1 (`toolExposureDefault` is omitted).
 */
export const Settings = z.object({
  retention: z.object({
    auditDays: z.number().int().min(1).max(3650),
    /** 1h rollups */
    metricsDays: z.number().int().min(1).max(3650),
    storeFullOutput: z.boolean(),
  }),
  approvals: z.object({
    timeoutMinutes: z.number().int().min(1).max(60),
    maxTimeoutMinutes: z.number().int().min(1).max(60),
    allowSelfApproval: z.boolean(),
  }),
  sessions: z.object({ idleMinutes: z.number().int().min(1).max(1440) }),
  rateLimits: z.object({ agent: RateLimitPair, tool: RateLimitPair }),
  catalogVisibility: z.enum(['all', 'granted']),
  oauth: z.object({
    dcrEnabled: z.boolean(),
    cimdPolicy: z.object({ mode: z.enum(['any', 'allowlist']), allowedHosts: z.array(z.string()) }),
  }),
  export: z.object({
    webhookUrl: z.string().nullable(),
    hasWebhookSecret: z.boolean(),
    webhookEnabled: z.boolean(),
    otlpEndpoint: z.string().nullable(),
    otlpLogsEnabled: z.boolean(),
    source: z.enum(['env', 'db']),
  }),
});
export type Settings = z.infer<typeof Settings>;

/** Deep-partial patch plus the write-only `export.webhookSecret`. Fields sourced from env → 409. */
export const UpdateSettingsBody = z.object({
  retention: Settings.shape.retention.partial().optional(),
  approvals: Settings.shape.approvals.partial().optional(),
  sessions: Settings.shape.sessions.partial().optional(),
  rateLimits: z.object({ agent: RateLimitPair.partial().optional(), tool: RateLimitPair.partial().optional() }).optional(),
  catalogVisibility: Settings.shape.catalogVisibility.optional(),
  oauth: z
    .object({
      dcrEnabled: z.boolean().optional(),
      cimdPolicy: Settings.shape.oauth.shape.cimdPolicy.partial().optional(),
    })
    .optional(),
  export: z
    .object({
      webhookUrl: z.url().nullable().optional(),
      webhookSecret: z.string().min(16).max(512).optional(),
      webhookEnabled: z.boolean().optional(),
      otlpLogsEnabled: z.boolean().optional(),
    })
    .optional(),
});
export type UpdateSettingsBody = z.infer<typeof UpdateSettingsBody>;

export const RoleMapping = z.object({ claim: z.string().min(1).max(100), value: z.string().min(1).max(500), role: Role });
export type RoleMapping = z.infer<typeof RoleMapping>;

/** OIDC connection config is env-only in P1 (Q16 / D2); only role mappings are editable. */
export const OidcSettings = z.object({
  issuer: z.string().nullable(),
  clientId: z.string().nullable(),
  hasClientSecret: z.boolean(),
  scopes: z.array(z.string()),
  groupsClaim: z.string(),
  redirectUri: z.string(),
  roleMappings: z.array(RoleMapping),
  source: z.literal('env'),
});
export type OidcSettings = z.infer<typeof OidcSettings>;

export const UpdateOidcSettingsBody = z.object({ roleMappings: z.array(RoleMapping).max(200) });
export type UpdateOidcSettingsBody = z.infer<typeof UpdateOidcSettingsBody>;

export const OidcTestBody = z.object({ issuer: z.url() });
export const OidcTestResult = z.object({
  ok: z.boolean(),
  issuer: z.string(),
  authorizationEndpoint: z.string().nullable(),
  error: z.string().nullable(),
});
export type OidcTestResult = z.infer<typeof OidcTestResult>;

export const ExportTestResult = z.object({ ok: z.boolean(), status: z.number().int().nullable(), error: z.string().nullable() });
export type ExportTestResult = z.infer<typeof ExportTestResult>;

export const settingsEndpoints = {
  get: endpoint({
    method: 'GET', path: '/api/settings', kind: 'json', access: ['auditor'],
    summary: 'Gateway settings (secrets masked)', response: Settings,
  }),
  update: endpoint({
    method: 'PATCH', path: '/api/settings', kind: 'json', access: ['admin'],
    summary: 'Partial update (env-sourced fields → 409)', body: UpdateSettingsBody, response: Settings,
  }),
  oidc: endpoint({
    method: 'GET', path: '/api/settings/oidc', kind: 'json', access: ['auditor'],
    summary: 'OIDC config and role mappings', response: OidcSettings,
  }),
  updateOidc: endpoint({
    method: 'PATCH', path: '/api/settings/oidc', kind: 'json', access: ['admin'],
    summary: 'Update role mappings (connection fields are env-only → 409)', body: UpdateOidcSettingsBody, response: OidcSettings,
  }),
  testOidc: endpoint({
    method: 'POST', path: '/api/settings/oidc/test', kind: 'json', access: ['admin'],
    summary: 'SSRF-guarded discovery check', body: OidcTestBody, response: OidcTestResult,
  }),
  testExport: endpoint({
    method: 'POST', path: '/api/settings/export/test', kind: 'json', access: ['admin'],
    summary: 'Send a signed test event to the webhook', response: ExportTestResult,
  }),
} as const;
