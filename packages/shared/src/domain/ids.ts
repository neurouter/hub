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

/**
 * The built-in "Everyone" group: every user is an implicit member (no membership rows), so a
 * grant to it opens a server or tool to the whole organization. Only admins may grant to it.
 */
export const EVERYONE_GROUP_ID = '00000000-0000-7000-8000-00000000e001';
