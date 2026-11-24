import * as z from 'zod';
import { Capability } from '../domain/capabilities.js';
import { MembershipSource, ThemePreference } from '../domain/enums.js';
import { Role } from '../domain/roles.js';
import { Id, IsoDateTime, Ref } from './common.js';
import { endpoint } from './endpoint.js';

export const GroupMembershipRef = Ref.extend({ source: MembershipSource });
export type GroupMembershipRef = z.infer<typeof GroupMembershipRef>;

export const Features = z.object({
  skills: z.boolean(),
  favorites: z.boolean(),
  /** Always true in P1 (hybrid, or keyword-only when embeddings are off; see /api/system/info.searchMode). */
  toolSearch: z.boolean(),
  oauthClients: z.boolean(),
});
export type Features = z.infer<typeof Features>;

export const Preferences = z.object({ theme: ThemePreference.optional() });
export type Preferences = z.infer<typeof Preferences>;

export const Me = z.object({
  user: z.object({ id: Id, email: z.string(), name: z.string(), avatarUrl: z.string().nullable() }),
  roles: z.array(Role),
  groups: z.array(GroupMembershipRef),
  capabilities: z.array(Capability),
  ownedServerIds: z.array(Id),
  csrfToken: z.string(),
  serverTime: IsoDateTime,
  features: Features,
  org: z.object({ name: z.string() }),
  version: z.string(),
  preferences: Preferences.optional(),
});
export type Me = z.infer<typeof Me>;

export const UpdatePreferencesBody = Preferences.strict();
export type UpdatePreferencesBody = z.infer<typeof UpdatePreferencesBody>;
export const PreferencesResponse = z.object({ preferences: Preferences });
export type PreferencesResponse = z.infer<typeof PreferencesResponse>;

export const Badges = z.object({
  pendingApprovals: z.number().int().nonnegative(),
  pendingAccessRequests: z.number().int().nonnegative(),
  toolsPendingReview: z.number().int().nonnegative(),
  myPendingRequests: z.number().int().nonnegative(),
  brokenConnections: z.number().int().nonnegative(),
});
export type Badges = z.infer<typeof Badges>;
export type BadgeKey = keyof Badges;

export const meEndpoints = {
  me: endpoint({ method: 'GET', path: '/api/me', kind: 'json', access: ['user'], summary: 'Current identity', response: Me }),
  updatePreferences: endpoint({
    method: 'PATCH', path: '/api/me/preferences', kind: 'json', access: ['user'],
    summary: 'Update own preferences', body: UpdatePreferencesBody, response: PreferencesResponse,
  }),
  badges: endpoint({
    method: 'GET', path: '/api/me/badges', kind: 'json', access: ['user'],
    summary: 'Counts of items the caller can act on', response: Badges,
  }),
} as const;
