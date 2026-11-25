// Kysely table types for every Phase 1 table (backend plan §4.2). Generated once from the
// migration column lists; `schema.test.ts` applies all migrations to SQLite and fails on drift.
import type { ColumnType, Generated } from 'kysely';
import type { AuditDecision, AuditKind, AuditStatus } from '@neurouter/shared';
import type { JsonColumn } from '../lib/json.js';

/** 0/1 integers on both dialects. */
export type BoolColumn = 0 | 1;
type UserStatusCol = 'active' | 'disabled';
export type { ColumnType, Generated };

export interface UsersTable {
  id: string;
  email: string;
  name: Generated<string>;
  oidc_issuer: string | null;
  oidc_subject: string | null;
  status: Generated<UserStatusCol>;
  avatar_url: string | null;
  last_login_at: number | null;
  preferences: Generated<JsonColumn>;
  created_at: number;
  updated_at: number;
}

export interface UserRolesTable {
  user_id: string;
  role: 'admin' | 'auditor';
  source: 'local' | 'oidc' | 'bootstrap';
  created_at: number;
  created_by: string | null;
}

export interface GroupsTable {
  id: string;
  name: string;
  description: Generated<string>;
  source: 'local' | 'oidc';
  created_at: number;
  updated_at: number;
}

export interface GroupClaimMappingsTable {
  id: string;
  group_id: string;
  claim: string;
  value: string;
  last_seen_at: number | null;
  created_by: string | null;
  created_at: number;
}

export interface GroupMembershipsTable {
  group_id: string;
  user_id: string;
  source: 'local' | 'oidc';
  created_at: number;
}

export interface OauthClientsTable {
  id: string;
  client_id: string;
  registration_type: 'cimd' | 'dcr' | 'preregistered';
  client_name: string;
  client_uri: string | null;
  logo_uri: string | null;
  redirect_uris: Generated<JsonColumn>;
  grant_types: Generated<JsonColumn>;
  response_types: Generated<JsonColumn>;
  token_endpoint_auth_method: 'none' | 'client_secret_basic' | 'client_secret_post' | 'private_key_jwt';
  client_secret_hash: Buffer | null;
  application_type: 'native' | 'web' | null;
  metadata: Generated<JsonColumn>;
  metadata_fetched_at: number | null;
  metadata_expires_at: number | null;
  status: Generated<'active' | 'blocked'>;
  created_at: number;
  updated_at: number;
}

export interface AgentsTable {
  id: string;
  owner_user_id: string;
  name: string;
  description: Generated<string>;
  kind: 'api' | 'oauth_client';
  oauth_client_id: string | null;
  exposure_mode: 'meta' | 'list' | null;
  narrowed: Generated<BoolColumn>;
  rate_limit: JsonColumn | null;
  status: Generated<'active' | 'disabled' | 'deleted'>;
  last_seen_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ApiKeysTable {
  id: string;
  agent_id: string;
  name: string;
  key_id: string;
  secret_hash: Buffer;
  display_prefix: string;
  expires_at: number | null;
  last_used_at: number | null;
  last_used_ip: string | null;
  revoked_at: number | null;
  created_by: string;
  created_at: number;
}

export interface WebSessionsTable {
  id_hash: Buffer;
  user_id: string;
  csrf_token: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
  ip: string | null;
  user_agent: string | null;
  id_token_hint: string | null;
}

export interface OidcLoginStatesTable {
  state_hash: Buffer;
  code_verifier_enc: Buffer;
  nonce: string;
  return_to: string;
  expires_at: number;
}

export interface ServersTable {
  id: string;
  slug: string;
  name: string;
  owner_user_id: string;
  description: Generated<string>;
  url: string;
  transport: 'streamable_http' | 'sse';
  auth_mode: 'none' | 'shared' | 'user_oauth';
  trusted: Generated<BoolColumn>;
  enabled: Generated<BoolColumn>;
  tags: Generated<JsonColumn>;
  icon_url: string | null;
  timeout_ms: Generated<number>;
  sync_interval_min: number | null;
  auto_approve_new_tools: Generated<BoolColumn>;
  pinning_mode: Generated<'strict' | 'monitor'>;
  oauth_config: JsonColumn | null;
  rate_limit: JsonColumn | null;
  detected_era: 'modern' | 'legacy' | 'legacy_sse' | null;
  protocol_version: string | null;
  server_info: JsonColumn | null;
  capabilities: JsonColumn | null;
  status: Generated<'active' | 'disabled' | 'error'>;
  last_synced_at: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface ServerIconsTable {
  server_id: string;
  source_url: string;
  content_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml' | null;
  bytes: Buffer | null;
  etag: string | null;
  fetched_at: number;
  error: string | null;
}

export interface EncryptionKeysTable {
  id: string;
  kek_id: string;
  wrapped_key: Buffer;
  status: 'active' | 'retired';
  created_at: number;
}

export interface SecretsTable {
  id: string;
  purpose: string;
  provider: Generated<'builtin'>;
  external_ref: string | null;
  dek_id: string | null;
  nonce: Buffer | null;
  ciphertext: Buffer | null;
  version: Generated<number>;
  created_at: number;
  updated_at: number;
}

export interface ServerCredentialsTable {
  id: string;
  server_id: string;
  kind: 'shared_bearer' | 'shared_header' | 'oauth_client_secret';
  header_name: string | null;
  secret_id: string;
  created_at: number;
  updated_at: number;
  rotated_at: number | null;
}

export interface UserUpstreamTokensTable {
  id: string;
  user_id: string;
  server_id: string;
  issuer: string;
  dek_id: string;
  access_nonce: Buffer;
  access_ct: Buffer;
  refresh_nonce: Buffer | null;
  refresh_ct: Buffer | null;
  token_type: Generated<string>;
  scopes: Generated<string>;
  expires_at: number | null;
  status: Generated<'active' | 'refresh_failed' | 'revoked'>;
  refreshed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface UpstreamOauthStatesTable {
  state_hash: Buffer;
  user_id: string;
  server_id: string;
  issuer: string;
  code_verifier_enc: Buffer;
  redirect_after: string;
  expires_at: number;
}

export interface ToolsTable {
  id: string;
  server_id: string;
  seq: number;
  upstream_name: string;
  exposed_name: string;
  title: string | null;
  description: Generated<string>;
  input_schema: JsonColumn;
  output_schema: JsonColumn | null;
  annotations: JsonColumn | null;
  icons: JsonColumn | null;
  execution: JsonColumn | null;
  pinned_hash: string | null;
  pending_hash: string | null;
  pending_definition: JsonColumn | null;
  status: 'pending_review' | 'active' | 'changed' | 'removed' | 'rejected';
  enabled: Generated<BoolColumn>;
  requires_approval: Generated<BoolColumn>;
  approval_timeout_sec: number | null;
  rate_limit: JsonColumn | null;
  search_text: Generated<string>;
  first_seen_at: number;
  last_seen_at: number;
  approved_by: string | null;
  approved_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ToolVersionsTable {
  id: string;
  tool_id: string;
  hash: string;
  definition: JsonColumn;
  first_seen_at: number;
  decision: 'pending' | 'approved' | 'rejected' | 'superseded';
  decided_by: string | null;
  decided_at: number | null;
}

export interface ToolSyncRunsTable {
  id: string;
  server_id: string;
  trigger: 'schedule' | 'manual' | 'notification';
  started_at: number;
  finished_at: number | null;
  status: 'running' | 'ok' | 'error';
  added: Generated<number>;
  changed: Generated<number>;
  removed: Generated<number>;
  unchanged: Generated<number>;
  error: string | null;
}

export interface ServerHealthTable {
  server_id: string;
  status: 'up' | 'degraded' | 'down' | 'unknown';
  latency_ms: number | null;
  checked_at: number | null;
  error: string | null;
  consecutive_failures: Generated<number>;
}

export interface ServerHealthChecksTable {
  server_id: string;
  checked_at: number;
  ok: BoolColumn;
  latency_ms: number | null;
}

export interface GrantsTable {
  id: string;
  subject_type: 'user' | 'group' | 'agent';
  subject_id: string;
  target_type: 'server' | 'tool';
  target_id: string;
  effect: 'allow' | 'deny';
  expires_at: number | null;
  source: Generated<'manual' | 'access_request'>;
  access_request_id: string | null;
  conditions: JsonColumn | null;
  note: string | null;
  created_by: string;
  created_at: number;
}

export interface AccessRequestsTable {
  id: string;
  requester_user_id: string;
  agent_id: string | null;
  target_type: 'server' | 'tool';
  target_id: string;
  server_id: string;
  reason: string;
  requested_duration_days: number | null;
  status: Generated<'pending' | 'approved' | 'denied' | 'cancelled'>;
  decided_by: string | null;
  decided_at: number | null;
  decision_note: string | null;
  grant_id: string | null;
  created_at: number;
}

export interface RateLimitBucketsTable {
  key: string;
  tokens: number;
  capacity: number;
  refill_per_ms: number;
  updated_at: number;
}

export interface ToolEmbeddingsTable {
  tool_id: string;
  tool_seq: number;
  model_id: string;
  dims: number;
  text_hash: string;
  embedding: Buffer | string | number[];
  updated_at: number;
}

export interface ToolUsageStatsTable {
  subject_type: 'agent' | 'user';
  subject_id: string;
  tool_id: string;
  calls: Generated<number>;
  successes: Generated<number>;
  decayed: Generated<number>;
  last_used_at: number | null;
}

export interface ToolPinsTable {
  subject_type: 'agent' | 'user';
  subject_id: string;
  tool_id: string;
  created_at: number;
}

export interface ApprovalsTable {
  id: string;
  tool_id: string;
  server_id: string;
  agent_id: string;
  user_id: string;
  audit_request_id: string;
  arguments_redacted: JsonColumn;
  arguments_hash: string;
  status: Generated<'pending' | 'approved' | 'denied' | 'expired' | 'cancelled' | 'abandoned'>;
  held_by_instance: string;
  heartbeat_at: number;
  expires_at: number;
  decided_by: string | null;
  decided_at: number | null;
  reason: string | null;
  client_name: string | null;
  client_version: string | null;
  auth_method: Generated<'api_key' | 'oauth'>;
  /** The API key that made the held call (null for OAuth). */
  api_key_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface OauthAuthzRequestsTable {
  id: string;
  client_id: string;
  params: JsonColumn;
  user_id: string | null;
  csrf_token: string;
  expires_at: number;
}

export interface OauthConsentsTable {
  id: string;
  user_id: string;
  client_id: string;
  agent_id: string;
  scopes: string;
  redirect_uri: string;
  created_at: number;
  revoked_at: number | null;
}

export interface OauthCodesTable {
  code_hash: Buffer;
  client_id: string;
  user_id: string;
  agent_id: string;
  redirect_uri: string;
  code_challenge: string;
  scopes: string;
  resource: string;
  expires_at: number;
  consumed_at: number | null;
}

export interface OauthTokensTable {
  id: string;
  token_hash: Buffer;
  kind: 'access' | 'refresh';
  client_id: string;
  user_id: string;
  agent_id: string;
  scopes: string;
  resource: string;
  family_id: string;
  parent_id: string | null;
  expires_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
  created_at: number;
}

export interface SettingsTable {
  key: string;
  value: JsonColumn;
  updated_by: string | null;
  updated_at: number;
}

export interface RedactionRulesTable {
  id: string;
  name: string;
  type: 'key' | 'regex';
  pattern: string;
  replacement: string;
  enabled: Generated<BoolColumn>;
  'order': number;
  builtin: Generated<BoolColumn>;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface LeasesTable {
  name: string;
  holder: string;
  expires_at: number;
}

export interface CoordSignalsTable {
  channel: string;
  payload: JsonColumn;
  created_at: number;
}

export interface JobsTable {
  id: string;
  kind: 'tool_sync' | 'audit_verify' | 'key_rotation' | 'reindex';
  status: 'queued' | 'running' | 'ok' | 'error';
  params: JsonColumn | null;
  progress: number | null;
  result: JsonColumn | null;
  error: string | null;
  created_by: string | null;
  created_at: number;
  finished_at: number | null;
}

export interface AuditLogTable {
  seq: number;
  id: string;
  ts: number;
  kind: AuditKind;
  request_id: string | null;
  user_id: string | null;
  agent_id: string | null;
  api_key_id: string | null;
  oauth_client_id: string | null;
  client_name: string | null;
  client_version: string | null;
  protocol_version: string | null;
  client_era: string | null;
  server_id: string | null;
  tool_id: string | null;
  tool_name: string | null;
  action: string | null;
  target_type: string | null;
  target_id: string | null;
  decision: AuditDecision;
  decision_reason: string | null;
  status: AuditStatus;
  params_redacted: JsonColumn | null;
  params_text: string | null;
  changes: JsonColumn | null;
  output_size: number | null;
  output_hash: string | null;
  output_full: JsonColumn | null;
  latency_ms: number | null;
  upstream_latency_ms: number | null;
  error_code: string | null;
  error_message: string | null;
  trace_id: string | null;
  span_id: string | null;
  session_id: string | null;
  ip: string | null;
  user_agent: string | null;
  prev_hash: string;
  hash: string;
}

export interface AuditCheckpointsTable {
  id: string;
  seq: number;
  hash: string;
  kind: 'periodic' | 'retention_cut' | 'key_rotation';
  mac: string;
  key_id: string;
  created_at: number;
}

export interface AuditSinkCursorsTable {
  sink: string;
  last_seq: number;
  updated_at: number;
  last_error: string | null;
}

export interface MetricRollups1mTable {
  bucket: number;
  server_id: Generated<string>;
  tool_id: Generated<string>;
  agent_id: Generated<string>;
  user_id: Generated<string>;
  calls: Generated<number>;
  ok: Generated<number>;
  tool_errors: Generated<number>;
  upstream_errors: Generated<number>;
  timeouts: Generated<number>;
  blocked: Generated<number>;
  approvals: Generated<number>;
  latency_sum_ms: Generated<number>;
  latency_max_ms: Generated<number>;
  h00: Generated<number>;
  h01: Generated<number>;
  h02: Generated<number>;
  h03: Generated<number>;
  h04: Generated<number>;
  h05: Generated<number>;
  h06: Generated<number>;
  h07: Generated<number>;
  h08: Generated<number>;
  h09: Generated<number>;
  h10: Generated<number>;
  h11: Generated<number>;
  h12: Generated<number>;
  h13: Generated<number>;
  h14: Generated<number>;
  h15: Generated<number>;
  h16: Generated<number>;
  h17: Generated<number>;
  h18: Generated<number>;
  h19: Generated<number>;
}

export interface MetricRollups1hTable {
  bucket: number;
  server_id: Generated<string>;
  tool_id: Generated<string>;
  agent_id: Generated<string>;
  user_id: Generated<string>;
  calls: Generated<number>;
  ok: Generated<number>;
  tool_errors: Generated<number>;
  upstream_errors: Generated<number>;
  timeouts: Generated<number>;
  blocked: Generated<number>;
  approvals: Generated<number>;
  latency_sum_ms: Generated<number>;
  latency_max_ms: Generated<number>;
  h00: Generated<number>;
  h01: Generated<number>;
  h02: Generated<number>;
  h03: Generated<number>;
  h04: Generated<number>;
  h05: Generated<number>;
  h06: Generated<number>;
  h07: Generated<number>;
  h08: Generated<number>;
  h09: Generated<number>;
  h10: Generated<number>;
  h11: Generated<number>;
  h12: Generated<number>;
  h13: Generated<number>;
  h14: Generated<number>;
  h15: Generated<number>;
  h16: Generated<number>;
  h17: Generated<number>;
  h18: Generated<number>;
  h19: Generated<number>;
}

export interface McpSessionsTable {
  id: string;
  source: 'client' | 'trace' | 'legacy' | 'idle_gap';
  external_key: string;
  agent_id: string;
  user_id: string;
  client_name: string | null;
  first_seen_at: number;
  last_seen_at: number;
  calls: Generated<number>;
  errors: Generated<number>;
  blocked: Generated<number>;
  servers: Generated<JsonColumn>;
}

/** Control-plane database (DATABASE_URL). */
export interface MainDB {
  users: UsersTable;
  user_roles: UserRolesTable;
  groups: GroupsTable;
  group_claim_mappings: GroupClaimMappingsTable;
  group_memberships: GroupMembershipsTable;
  oauth_clients: OauthClientsTable;
  agents: AgentsTable;
  api_keys: ApiKeysTable;
  web_sessions: WebSessionsTable;
  oidc_login_states: OidcLoginStatesTable;
  servers: ServersTable;
  server_icons: ServerIconsTable;
  encryption_keys: EncryptionKeysTable;
  secrets: SecretsTable;
  server_credentials: ServerCredentialsTable;
  user_upstream_tokens: UserUpstreamTokensTable;
  upstream_oauth_states: UpstreamOauthStatesTable;
  tools: ToolsTable;
  tool_versions: ToolVersionsTable;
  tool_sync_runs: ToolSyncRunsTable;
  server_health: ServerHealthTable;
  server_health_checks: ServerHealthChecksTable;
  grants: GrantsTable;
  access_requests: AccessRequestsTable;
  rate_limit_buckets: RateLimitBucketsTable;
  tool_embeddings: ToolEmbeddingsTable;
  tool_usage_stats: ToolUsageStatsTable;
  tool_pins: ToolPinsTable;
  approvals: ApprovalsTable;
  oauth_authz_requests: OauthAuthzRequestsTable;
  oauth_consents: OauthConsentsTable;
  oauth_codes: OauthCodesTable;
  oauth_tokens: OauthTokensTable;
  settings: SettingsTable;
  redaction_rules: RedactionRulesTable;
  leases: LeasesTable;
  coord_signals: CoordSignalsTable;
  jobs: JobsTable;
}

/** Audit database (AUDIT_DATABASE_URL, defaults to DATABASE_URL): audit log, sessions, rollups. */
export interface AuditDB {
  audit_log: AuditLogTable;
  audit_checkpoints: AuditCheckpointsTable;
  audit_sink_cursors: AuditSinkCursorsTable;
  metric_rollups_1m: MetricRollups1mTable;
  metric_rollups_1h: MetricRollups1hTable;
  mcp_sessions: McpSessionsTable;
}

export type DB = MainDB & AuditDB;

/** Runtime column inventory (the drift test compares it to the migrated schema). */
export const MAIN_TABLE_COLUMNS = {
  users: ['id', 'email', 'name', 'oidc_issuer', 'oidc_subject', 'status', 'avatar_url', 'last_login_at', 'preferences', 'created_at', 'updated_at'],
  user_roles: ['user_id', 'role', 'source', 'created_at', 'created_by'],
  groups: ['id', 'name', 'description', 'source', 'created_at', 'updated_at'],
  group_claim_mappings: ['id', 'group_id', 'claim', 'value', 'last_seen_at', 'created_by', 'created_at'],
  group_memberships: ['group_id', 'user_id', 'source', 'created_at'],
  oauth_clients: ['id', 'client_id', 'registration_type', 'client_name', 'client_uri', 'logo_uri', 'redirect_uris', 'grant_types', 'response_types', 'token_endpoint_auth_method', 'client_secret_hash', 'application_type', 'metadata', 'metadata_fetched_at', 'metadata_expires_at', 'status', 'created_at', 'updated_at'],
  agents: ['id', 'owner_user_id', 'name', 'description', 'kind', 'oauth_client_id', 'exposure_mode', 'narrowed', 'rate_limit', 'status', 'last_seen_at', 'created_at', 'updated_at'],
  api_keys: ['id', 'agent_id', 'name', 'key_id', 'secret_hash', 'display_prefix', 'expires_at', 'last_used_at', 'last_used_ip', 'revoked_at', 'created_by', 'created_at'],
  web_sessions: ['id_hash', 'user_id', 'csrf_token', 'created_at', 'expires_at', 'last_seen_at', 'ip', 'user_agent', 'id_token_hint'],
  oidc_login_states: ['state_hash', 'code_verifier_enc', 'nonce', 'return_to', 'expires_at'],
  servers: ['id', 'slug', 'name', 'owner_user_id', 'description', 'url', 'transport', 'auth_mode', 'trusted', 'enabled', 'tags', 'icon_url', 'timeout_ms', 'sync_interval_min', 'auto_approve_new_tools', 'pinning_mode', 'oauth_config', 'rate_limit', 'detected_era', 'protocol_version', 'server_info', 'capabilities', 'status', 'last_synced_at', 'created_by', 'created_at', 'updated_at'],
  server_icons: ['server_id', 'source_url', 'content_type', 'bytes', 'etag', 'fetched_at', 'error'],
  encryption_keys: ['id', 'kek_id', 'wrapped_key', 'status', 'created_at'],
  secrets: ['id', 'purpose', 'provider', 'external_ref', 'dek_id', 'nonce', 'ciphertext', 'version', 'created_at', 'updated_at'],
  server_credentials: ['id', 'server_id', 'kind', 'header_name', 'secret_id', 'created_at', 'updated_at', 'rotated_at'],
  user_upstream_tokens: ['id', 'user_id', 'server_id', 'issuer', 'dek_id', 'access_nonce', 'access_ct', 'refresh_nonce', 'refresh_ct', 'token_type', 'scopes', 'expires_at', 'status', 'refreshed_at', 'created_at', 'updated_at'],
  upstream_oauth_states: ['state_hash', 'user_id', 'server_id', 'issuer', 'code_verifier_enc', 'redirect_after', 'expires_at'],
  tools: ['id', 'server_id', 'seq', 'upstream_name', 'exposed_name', 'title', 'description', 'input_schema', 'output_schema', 'annotations', 'icons', 'execution', 'pinned_hash', 'pending_hash', 'pending_definition', 'status', 'enabled', 'requires_approval', 'approval_timeout_sec', 'rate_limit', 'search_text', 'first_seen_at', 'last_seen_at', 'approved_by', 'approved_at', 'created_at', 'updated_at'],
  tool_versions: ['id', 'tool_id', 'hash', 'definition', 'first_seen_at', 'decision', 'decided_by', 'decided_at'],
  tool_sync_runs: ['id', 'server_id', 'trigger', 'started_at', 'finished_at', 'status', 'added', 'changed', 'removed', 'unchanged', 'error'],
  server_health: ['server_id', 'status', 'latency_ms', 'checked_at', 'error', 'consecutive_failures'],
  server_health_checks: ['server_id', 'checked_at', 'ok', 'latency_ms'],
  grants: ['id', 'subject_type', 'subject_id', 'target_type', 'target_id', 'effect', 'expires_at', 'source', 'access_request_id', 'conditions', 'note', 'created_by', 'created_at'],
  access_requests: ['id', 'requester_user_id', 'agent_id', 'target_type', 'target_id', 'server_id', 'reason', 'requested_duration_days', 'status', 'decided_by', 'decided_at', 'decision_note', 'grant_id', 'created_at'],
  rate_limit_buckets: ['key', 'tokens', 'capacity', 'refill_per_ms', 'updated_at'],
  tool_embeddings: ['tool_id', 'tool_seq', 'model_id', 'dims', 'text_hash', 'embedding', 'updated_at'],
  tool_usage_stats: ['subject_type', 'subject_id', 'tool_id', 'calls', 'successes', 'decayed', 'last_used_at'],
  tool_pins: ['subject_type', 'subject_id', 'tool_id', 'created_at'],
  approvals: ['id', 'tool_id', 'server_id', 'agent_id', 'user_id', 'audit_request_id', 'arguments_redacted', 'arguments_hash', 'status', 'held_by_instance', 'heartbeat_at', 'expires_at', 'decided_by', 'decided_at', 'reason', 'client_name', 'client_version', 'auth_method', 'api_key_id', 'created_at', 'updated_at'],
  oauth_authz_requests: ['id', 'client_id', 'params', 'user_id', 'csrf_token', 'expires_at'],
  oauth_consents: ['id', 'user_id', 'client_id', 'agent_id', 'scopes', 'redirect_uri', 'created_at', 'revoked_at'],
  oauth_codes: ['code_hash', 'client_id', 'user_id', 'agent_id', 'redirect_uri', 'code_challenge', 'scopes', 'resource', 'expires_at', 'consumed_at'],
  oauth_tokens: ['id', 'token_hash', 'kind', 'client_id', 'user_id', 'agent_id', 'scopes', 'resource', 'family_id', 'parent_id', 'expires_at', 'revoked_at', 'last_used_at', 'created_at'],
  settings: ['key', 'value', 'updated_by', 'updated_at'],
  redaction_rules: ['id', 'name', 'type', 'pattern', 'replacement', 'enabled', 'order', 'builtin', 'created_by', 'created_at', 'updated_at'],
  leases: ['name', 'holder', 'expires_at'],
  coord_signals: ['channel', 'payload', 'created_at'],
  jobs: ['id', 'kind', 'status', 'params', 'progress', 'result', 'error', 'created_by', 'created_at', 'finished_at'],
} as const satisfies { [T in keyof MainDB]: readonly (keyof MainDB[T])[] };

export const AUDIT_TABLE_COLUMNS = {
  audit_log: ['seq', 'id', 'ts', 'kind', 'request_id', 'user_id', 'agent_id', 'api_key_id', 'oauth_client_id', 'client_name', 'client_version', 'protocol_version', 'client_era', 'server_id', 'tool_id', 'tool_name', 'action', 'target_type', 'target_id', 'decision', 'decision_reason', 'status', 'params_redacted', 'params_text', 'changes', 'output_size', 'output_hash', 'output_full', 'latency_ms', 'upstream_latency_ms', 'error_code', 'error_message', 'trace_id', 'span_id', 'session_id', 'ip', 'user_agent', 'prev_hash', 'hash'],
  audit_checkpoints: ['id', 'seq', 'hash', 'kind', 'mac', 'key_id', 'created_at'],
  audit_sink_cursors: ['sink', 'last_seq', 'updated_at', 'last_error'],
  metric_rollups_1m: ['bucket', 'server_id', 'tool_id', 'agent_id', 'user_id', 'calls', 'ok', 'tool_errors', 'upstream_errors', 'timeouts', 'blocked', 'approvals', 'latency_sum_ms', 'latency_max_ms', 'h00', 'h01', 'h02', 'h03', 'h04', 'h05', 'h06', 'h07', 'h08', 'h09', 'h10', 'h11', 'h12', 'h13', 'h14', 'h15', 'h16', 'h17', 'h18', 'h19'],
  metric_rollups_1h: ['bucket', 'server_id', 'tool_id', 'agent_id', 'user_id', 'calls', 'ok', 'tool_errors', 'upstream_errors', 'timeouts', 'blocked', 'approvals', 'latency_sum_ms', 'latency_max_ms', 'h00', 'h01', 'h02', 'h03', 'h04', 'h05', 'h06', 'h07', 'h08', 'h09', 'h10', 'h11', 'h12', 'h13', 'h14', 'h15', 'h16', 'h17', 'h18', 'h19'],
  mcp_sessions: ['id', 'source', 'external_key', 'agent_id', 'user_id', 'client_name', 'first_seen_at', 'last_seen_at', 'calls', 'errors', 'blocked', 'servers'],
} as const satisfies { [T in keyof AuditDB]: readonly (keyof AuditDB[T])[] };

/** Compile-time check that the inventory lists every interface column (and nothing else). */
type Exact<T extends Record<string, readonly string[]>, D> = {
  [K in keyof D]: K extends keyof T ? (Exclude<keyof D[K], T[K][number]> extends never ? true : false) : false;
};
type AllTrue<T> = T[keyof T] extends true ? true : false;
const _mainExact: AllTrue<Exact<typeof MAIN_TABLE_COLUMNS, MainDB>> = true;
const _auditExact: AllTrue<Exact<typeof AUDIT_TABLE_COLUMNS, AuditDB>> = true;
void _mainExact;
void _auditExact;

/** Dialect-specific extras that exist only in one engine (not in the shared inventory). */
export const SQLITE_ONLY_TABLES = ['tools_fts', 'audit_fts'] as const;
export const POSTGRES_ONLY_COLUMNS = { tools: ['search_tsv'], audit_log: ['params_tsv'] } as const;
