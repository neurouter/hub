/** Branded id types. Ids are opaque UUIDv7 strings; the UI never parses them. */
declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type UserId = Brand<string, 'UserId'>;
export type GroupId = Brand<string, 'GroupId'>;
export type AgentId = Brand<string, 'AgentId'>;
export type ApiKeyId = Brand<string, 'ApiKeyId'>;
export type ServerId = Brand<string, 'ServerId'>;
export type ToolId = Brand<string, 'ToolId'>;
export type GrantId = Brand<string, 'GrantId'>;
export type AccessRequestId = Brand<string, 'AccessRequestId'>;
export type ApprovalId = Brand<string, 'ApprovalId'>;
export type AuditEventId = Brand<string, 'AuditEventId'>;
export type SessionId = Brand<string, 'SessionId'>;
export type JobId = Brand<string, 'JobId'>;
