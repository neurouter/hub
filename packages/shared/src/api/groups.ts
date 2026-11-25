import * as z from 'zod';
import { MembershipSource } from '../domain/enums.js';
import { Actions, CursorQuery, Id, IdParams, IsoDateTime, Items, Page, UserRefWithEmail, queryOptional } from './common.js';
import { endpoint } from './endpoint.js';

export const GroupRow = z.object({
  id: Id,
  name: z.string(),
  description: z.string(),
  source: MembershipSource,
  memberCount: z.number().int().nonnegative(),
  mappingCount: z.number().int().nonnegative(),
  grantCount: z.number().int().nonnegative(),
  /** The built-in Everyone group: all users are members; it can't be edited, deleted or mapped. */
  builtin: z.boolean().optional(),
});
export type GroupRow = z.infer<typeof GroupRow>;

export const GroupDetail = GroupRow.extend({ createdAt: IsoDateTime, updatedAt: IsoDateTime, actions: Actions });
export type GroupDetail = z.infer<typeof GroupDetail>;

/**
 * `GET /api/groups` returns full rows to Auditors/Admins and `Ref`-only rows to plain users
 * (for pickers), so the item schema accepts both.
 */
export const GroupListItem = z.union([GroupRow, z.object({ id: Id, name: z.string() })]);
export type GroupListItem = z.infer<typeof GroupListItem>;

export const ClaimMapping = z.object({ id: Id, claim: z.string(), value: z.string(), lastSeenAt: IsoDateTime.nullable() });
export type ClaimMapping = z.infer<typeof ClaimMapping>;

export const GroupMember = z.object({ user: UserRefWithEmail, source: MembershipSource, addedAt: IsoDateTime });
export type GroupMember = z.infer<typeof GroupMember>;

export const ListGroupsQuery = CursorQuery.extend({ q: queryOptional(z.string().max(200)), source: queryOptional(MembershipSource) });
export type ListGroupsQuery = z.infer<typeof ListGroupsQuery>;

export const CreateGroupBody = z.object({ name: z.string().trim().min(1).max(100), description: z.string().max(1000).optional() });
export type CreateGroupBody = z.infer<typeof CreateGroupBody>;
export const UpdateGroupBody = CreateGroupBody.partial();
export type UpdateGroupBody = z.infer<typeof UpdateGroupBody>;

export const ListMembersQuery = CursorQuery.extend({ q: queryOptional(z.string().max(200)) });
export type ListMembersQuery = z.infer<typeof ListMembersQuery>;
export const AddMembersBody = z.object({ userIds: z.array(Id).min(1).max(500) });
export type AddMembersBody = z.infer<typeof AddMembersBody>;
export const AddMembersResponse = z.object({ added: z.number().int().nonnegative() });

export const CreateClaimMappingBody = z.object({ claim: z.string().trim().min(1).max(100), value: z.string().trim().min(1).max(500) });
export type CreateClaimMappingBody = z.infer<typeof CreateClaimMappingBody>;

const GroupParams = z.object({ id: Id });
const MemberParams = z.object({ id: Id, userId: Id });
const MappingParams = z.object({ id: Id, mappingId: Id });

export const groupEndpoints = {
  list: endpoint({
    method: 'GET', path: '/api/groups', kind: 'json', access: ['user', 'auditor'],
    summary: 'List groups (Ref only for users, full rows for auditors)', query: ListGroupsQuery, response: Page(GroupListItem),
  }),
  create: endpoint({
    method: 'POST', path: '/api/groups', kind: 'json', access: ['admin'],
    summary: 'Create a local group', body: CreateGroupBody, response: GroupRow,
  }),
  get: endpoint({
    method: 'GET', path: '/api/groups/:id', kind: 'json', access: ['auditor'],
    summary: 'Group detail', params: IdParams, response: GroupDetail,
  }),
  update: endpoint({
    method: 'PATCH', path: '/api/groups/:id', kind: 'json', access: ['admin'],
    summary: 'Edit a group', params: IdParams, body: UpdateGroupBody, response: GroupRow,
  }),
  delete: endpoint({
    method: 'DELETE', path: '/api/groups/:id', kind: 'empty', access: ['admin'],
    summary: 'Delete a group with its grants and mappings', params: IdParams,
  }),
  members: endpoint({
    method: 'GET', path: '/api/groups/:id/members', kind: 'json', access: ['auditor'],
    summary: 'Group members', params: GroupParams, query: ListMembersQuery, response: Page(GroupMember),
  }),
  addMembers: endpoint({
    method: 'POST', path: '/api/groups/:id/members', kind: 'json', access: ['admin'],
    summary: 'Add local members', params: GroupParams, body: AddMembersBody, response: AddMembersResponse,
  }),
  removeMember: endpoint({
    method: 'DELETE', path: '/api/groups/:id/members/:userId', kind: 'empty', access: ['admin'],
    summary: 'Remove a local membership (OIDC memberships → 409)', params: MemberParams,
  }),
  claimMappings: endpoint({
    method: 'GET', path: '/api/groups/:id/claim-mappings', kind: 'json', access: ['auditor'],
    summary: 'OIDC claim → group mappings', params: GroupParams, response: Items(ClaimMapping),
  }),
  createClaimMapping: endpoint({
    method: 'POST', path: '/api/groups/:id/claim-mappings', kind: 'json', access: ['admin'],
    summary: 'Add a claim mapping', params: GroupParams, body: CreateClaimMappingBody, response: ClaimMapping,
  }),
  deleteClaimMapping: endpoint({
    method: 'DELETE', path: '/api/groups/:id/claim-mappings/:mappingId', kind: 'empty', access: ['admin'],
    summary: 'Remove a claim mapping', params: MappingParams,
  }),
} as const;
