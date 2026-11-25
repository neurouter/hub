import * as z from 'zod';

/**
 * Domain enums shared by the server (DB CHECK constraints, services) and the web app.
 * Each enum is exported as a zod schema plus its value list and inferred type.
 */

export const ServerTransport = z.enum(['streamable_http', 'sse']);

/**
 * How a server's tool definitions are pinned (catalog/tool-sync.ts):
 * - `strict`: new and changed definitions are blocked until an owner approves them (default).
 * - `monitor`: changes apply at once; each one is kept as a version, audited and flagged for review
 *   afterwards. For first-party servers whose changes already go through your own code review.
 */
export const PinningMode = z.enum(['strict', 'monitor']);
export type PinningMode = z.infer<typeof PinningMode>;
export type ServerTransport = z.infer<typeof ServerTransport>;

/** DB-level auth mode (`servers.auth_mode`). */
export const ServerAuthMode = z.enum(['none', 'shared', 'user_oauth']);
export type ServerAuthMode = z.infer<typeof ServerAuthMode>;

/** API-level auth type (`ServerAuthIn.type`). */
export const ServerAuthType = z.enum(['none', 'shared_bearer', 'shared_header', 'per_user_oauth']);
export type ServerAuthType = z.infer<typeof ServerAuthType>;

export const ServerStatus = z.enum(['active', 'disabled', 'error']);
export type ServerStatus = z.infer<typeof ServerStatus>;

export const ServerEra = z.enum(['modern', 'legacy', 'legacy_sse']);
export type ServerEra = z.infer<typeof ServerEra>;

export const HealthStatus = z.enum(['up', 'degraded', 'down', 'unknown']);
export type HealthStatus = z.infer<typeof HealthStatus>;

/** DB-level tool status (`tools.status`). */
export const ToolStatus = z.enum(['pending_review', 'active', 'changed', 'removed', 'rejected']);
export type ToolStatus = z.infer<typeof ToolStatus>;

/** API-level review state (`ToolRow.reviewState`). */
export const ToolReviewState = z.enum(['approved', 'pending_review', 'rejected']);
export type ToolReviewState = z.infer<typeof ToolReviewState>;

export const ToolVersionDecision = z.enum(['pending', 'approved', 'rejected', 'superseded']);
export type ToolVersionDecision = z.infer<typeof ToolVersionDecision>;

export const SyncTrigger = z.enum(['schedule', 'manual', 'notification']);
export type SyncTrigger = z.infer<typeof SyncTrigger>;

export const SyncRunStatus = z.enum(['running', 'ok', 'error']);
export type SyncRunStatus = z.infer<typeof SyncRunStatus>;

export const GrantEffect = z.enum(['allow', 'deny']);
export type GrantEffect = z.infer<typeof GrantEffect>;

export const SubjectType = z.enum(['user', 'group', 'agent']);
export type SubjectType = z.infer<typeof SubjectType>;

export const TargetType = z.enum(['server', 'tool']);
export type TargetType = z.infer<typeof TargetType>;

export const GrantSource = z.enum(['manual', 'access_request']);
export type GrantSource = z.infer<typeof GrantSource>;

export const AccessDecision = z.enum(['allow', 'deny', 'none']);
export type AccessDecision = z.infer<typeof AccessDecision>;

export const AccessRequestStatus = z.enum(['pending', 'approved', 'denied', 'cancelled']);
export type AccessRequestStatus = z.infer<typeof AccessRequestStatus>;

export const ApprovalStatus = z.enum(['pending', 'approved', 'denied', 'expired', 'cancelled', 'abandoned']);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const AuditKind = z.enum(['tool_call', 'tool_search', 'tools_list', 'admin', 'auth', 'system']);
export type AuditKind = z.infer<typeof AuditKind>;

/**
 * Audit decision. `approved` (frontend addendum #3) marks the tool_call row of a call that ran
 * after a human approved it; `approval_approved` is the approval-decision event row itself.
 */
export const AuditDecision = z.enum([
  'allowed',
  'approved',
  'denied_acl',
  'denied_disabled',
  'denied_rate_limit',
  'approval_pending',
  'approval_approved',
  'approval_denied',
  'approval_timeout',
  'approval_cancelled',
  'not_applicable',
]);
export type AuditDecision = z.infer<typeof AuditDecision>;

export const AuditStatus = z.enum(['ok', 'tool_error', 'upstream_error', 'timeout', 'cancelled', 'blocked', 'invalid_args']);
export type AuditStatus = z.infer<typeof AuditStatus>;

/** True when the UI should render the decision as "blocked". */
export function isBlockedDecision(d: AuditDecision): boolean {
  return d.startsWith('denied_') || d === 'approval_denied' || d === 'approval_timeout' || d === 'approval_cancelled';
}

export const SessionSource = z.enum(['client', 'trace', 'legacy', 'idle_gap']);
export type SessionSource = z.infer<typeof SessionSource>;

export const AgentKind = z.enum(['api', 'oauth_client']);
export type AgentKind = z.infer<typeof AgentKind>;

export const AgentStatus = z.enum(['active', 'disabled']);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const ApiKeyStatus = z.enum(['active', 'expired', 'revoked']);
export type ApiKeyStatus = z.infer<typeof ApiKeyStatus>;

export const UserStatus = z.enum(['active', 'disabled']);
export type UserStatus = z.infer<typeof UserStatus>;

export const MembershipSource = z.enum(['local', 'oidc']);
export type MembershipSource = z.infer<typeof MembershipSource>;

export const JobKind = z.enum(['tool_sync', 'audit_verify', 'key_rotation', 'reindex']);
export type JobKind = z.infer<typeof JobKind>;

export const JobStatus = z.enum(['queued', 'running', 'succeeded', 'failed']);
export type JobStatus = z.infer<typeof JobStatus>;

export const OAuthRegistration = z.enum(['cimd', 'dcr', 'preregistered']);
export type OAuthRegistration = z.infer<typeof OAuthRegistration>;

export const OAuthClientIdMode = z.enum(['cimd', 'preregistered', 'dcr']);
export type OAuthClientIdMode = z.infer<typeof OAuthClientIdMode>;

export const RedactionRuleType = z.enum(['key', 'regex']);
export type RedactionRuleType = z.infer<typeof RedactionRuleType>;

export const ThemePreference = z.enum(['light', 'dark', 'system']);
export type ThemePreference = z.infer<typeof ThemePreference>;

export const AuthMethod = z.enum(['api_key', 'oauth']);
export type AuthMethod = z.infer<typeof AuthMethod>;

export const ConnectionStatus = z.enum(['connected', 'not_connected', 'expired', 'error']);
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;
