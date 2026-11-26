import {
  AuthProviders, Badges, ClientConfig, Me, capabilitiesFor, type DisplayRole, type Role,
} from '@neurouter/shared';

/**
 * Typed fixtures, parsed through the shared zod schemas so they can't drift from the contract.
 * People match the approved prototype.
 */
const PEOPLE: Record<DisplayRole, { id: string; name: string; email: string; roles: Role[]; owned: string[] }> = {
  admin: { id: '0193a000-0000-7000-8000-000000000001', name: 'Dana Whitfield', email: 'dana.whitfield@acme.example', roles: ['admin'], owned: [] },
  owner: { id: '0193a000-0000-7000-8000-000000000002', name: 'Marco Ruiz', email: 'marco.ruiz@acme.example', roles: [], owned: ['0193a000-0000-7000-8000-0000000000a1'] },
  auditor: { id: '0193a000-0000-7000-8000-000000000003', name: 'Priya Nair', email: 'priya.nair@acme.example', roles: ['auditor'], owned: [] },
  user: { id: '0193a000-0000-7000-8000-000000000004', name: 'Sam Okafor', email: 'sam.okafor@acme.example', roles: [], owned: [] },
};

export function meFixture(role: DisplayRole = 'admin', patch: Partial<Me> = {}): Me {
  const p = PEOPLE[role];
  return Me.parse({
    user: { id: p.id, email: p.email, name: p.name, avatarUrl: null },
    roles: p.roles,
    groups: [{ id: '0193a000-0000-7000-8000-0000000000b1', name: 'Engineering', source: 'oidc' }],
    capabilities: capabilitiesFor({ roles: p.roles, ownedServerIds: p.owned }),
    ownedServerIds: p.owned,
    csrfToken: 'csrf-test-token',
    serverTime: '2026-11-24T10:00:00.000Z',
    features: { skills: false, favorites: false, toolSearch: true, oauthClients: true },
    org: { name: 'Acme Corp' },
    version: '1.0',
    ...patch,
  });
}

export function badgesFixture(patch: Partial<Badges> = {}): Badges {
  return Badges.parse({ pendingApprovals: 4, pendingAccessRequests: 3, toolsPendingReview: 2, myPendingRequests: 1, brokenConnections: 0, ...patch });
}

export function providersFixture(patch: Partial<AuthProviders> = {}): AuthProviders {
  return AuthProviders.parse({ productName: 'Neurouter Hub', providers: [{ id: 'oidc', displayName: 'Okta' }], ...patch });
}

export function clientConfigFixture(): ClientConfig {
  return ClientConfig.parse({
    mcpUrl: 'https://mcp.acme.example/mcp',
    oauthSupported: true,
    protocolVersions: ['2026-07-28', '2025-11-25'],
    serverName: 'neurouter',
    apiKeyHeader: 'Authorization: Bearer',
  });
}
