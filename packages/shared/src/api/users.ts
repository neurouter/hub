import * as z from 'zod';
import { Role } from '../domain/roles.js';
import { UserStatus } from '../domain/enums.js';
import { Actions, CursorQuery, Id, IdParams, IsoDateTime, Page, Ref, queryOptional, sortParam } from './common.js';
import { GroupMembershipRef } from './me.js';
import { endpoint } from './endpoint.js';

export const UserRow = z.object({
  id: Id,
  email: z.string(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
  roles: z.array(Role),
  groups: z.array(GroupMembershipRef),
  status: UserStatus,
  lastLoginAt: IsoDateTime.nullable(),
  agentCount: z.number().int().nonnegative(),
});
export type UserRow = z.infer<typeof UserRow>;

export const UserDetail = UserRow.extend({
  agents: z.array(Ref),
  oidcLinked: z.boolean(),
  createdAt: IsoDateTime,
  actions: Actions,
});
export type UserDetail = z.infer<typeof UserDetail>;

export const USER_SORT_FIELDS = ['name', 'email', 'lastLoginAt'] as const;
export const ListUsersQuery = CursorQuery.extend({
  q: queryOptional(z.string().max(200)),
  role: queryOptional(Role),
  groupId: queryOptional(Id),
  status: queryOptional(UserStatus),
  sort: sortParam(USER_SORT_FIELDS),
  order: queryOptional(z.enum(['asc', 'desc'])),
});
export type ListUsersQuery = z.infer<typeof ListUsersQuery>;

export const CreateUserBody = z.object({
  email: z.email().max(320),
  name: z.string().min(1).max(200).optional(),
  roles: z.array(Role).optional(),
});
export type CreateUserBody = z.infer<typeof CreateUserBody>;

/** Only local roles are editable; OIDC/bootstrap roles are reconciled at login. */
export const UpdateUserBody = z.object({ roles: z.array(Role).optional(), status: UserStatus.optional() });
export type UpdateUserBody = z.infer<typeof UpdateUserBody>;

export const userEndpoints = {
  list: endpoint({
    method: 'GET', path: '/api/users', kind: 'json', access: ['auditor'],
    summary: 'List users', query: ListUsersQuery, response: Page(UserRow),
  }),
  create: endpoint({
    method: 'POST', path: '/api/users', kind: 'json', access: ['admin'],
    summary: 'Pre-provision a user', body: CreateUserBody, response: UserDetail,
  }),
  get: endpoint({
    method: 'GET', path: '/api/users/:id', kind: 'json', access: ['auditor'],
    summary: 'User detail', params: IdParams, response: UserDetail,
  }),
  update: endpoint({
    method: 'PATCH', path: '/api/users/:id', kind: 'json', access: ['admin'],
    summary: 'Update local roles / status (disabling kills sessions, keys and tokens)', params: IdParams, body: UpdateUserBody, response: UserDetail,
  }),
} as const;
