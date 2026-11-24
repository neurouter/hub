import { http, HttpResponse, type HttpHandler } from 'msw';
import type * as z from 'zod';
import { ALL_ENDPOINTS, PROBLEM_CONTENT_TYPE, problemType, type EndpointDef } from '@neurouter/shared';
import { badgesFixture, clientConfigFixture, meFixture, providersFixture } from './fixtures';
import { APPROVALS, SYSTEM_INFO } from './demo-data';
import { demoFixtures } from './demo-fixtures';

type Resolver = (ctx: { request: Request; params: Record<string, string | readonly string[] | undefined> }) => unknown | Response | Promise<unknown | Response>;

/** Fixture per endpoint key (`<area>.<name>`, e.g. `servers.get`): static data or a resolver. */
export type ContractFixtures = Partial<Record<string, unknown | Resolver>>;

const METHOD = { GET: http.get, POST: http.post, PUT: http.put, PATCH: http.patch, DELETE: http.delete } as const;

function problem(status: number, code: string, title: string, detail: string): Response {
  return HttpResponse.json(
    { type: problemType(code), title, status, code, detail, requestId: 'msw' },
    { status, headers: { 'content-type': PROBLEM_CONTENT_TYPE } },
  );
}

/**
 * MSW handlers generated from the shared contract: one per endpoint in `ALL_ENDPOINTS`.
 * Fixtures are validated against the endpoint's response schema (so mocks can't drift);
 * endpoints without a fixture answer 501 problem+json.
 */
/** Non-GET endpoints that only read or simulate, so the read-only demo still answers them. */
export const DEMO_READ_ONLY_ALLOW = new Set(['audit.verify', 'redaction.test', 'servers.testConnection', 'servers.healthCheck']);

export function createContractHandlers(fixtures: ContractFixtures = {}, opts: { readOnly?: boolean } = {}): HttpHandler[] {
  return ALL_ENDPOINTS.map(({ key, def }: { key: string; def: EndpointDef }) =>
    METHOD[def.method](def.path, async ({ request, params }) => {
      if (opts.readOnly && def.method !== 'GET' && !DEMO_READ_ONLY_ALLOW.has(key)) {
        return problem(403, 'demo_read_only', 'Read-only demo', "This is a read-only demo, so changes aren't saved. Run Neurouter yourself to try it.");
      }
      if (!(key in fixtures)) return problem(501, 'not_implemented', 'Not mocked', `No MSW fixture for ${key} (${def.method} ${def.path})`);
      const f = fixtures[key];
      const value = typeof f === 'function' ? await (f as Resolver)({ request, params }) : f;
      if (value instanceof Response) return value;
      if (def.kind === 'empty') return new HttpResponse(null, { status: 204 });
      if (!def.response) return HttpResponse.json(value ?? null, { status: def.status });
      const parsed = (def.response as z.ZodType).safeParse(value);
      if (!parsed.success) return problem(500, 'internal', 'Invalid fixture', `Fixture for ${key} does not match the contract: ${parsed.error.message}`);
      return HttpResponse.json(parsed.data as never, { status: def.status });
    }),
  );
}

/** Defaults: signed-in admin, badges, providers, client config and the demo dataset (mocks/demo-data.ts). */
export function defaultFixtures(): ContractFixtures {
  return {
    ...demoFixtures(),
    'me.me': meFixture('admin'),
    'me.badges': badgesFixture(),
    'auth.providers': providersFixture({ providers: [{ id: 'oidc', displayName: 'Okta' }, { id: 'dev', displayName: 'Development login' }] }),
    'auth.logout': { redirectTo: '/auth/logged-out' },
    'auth.devLogin': null,
    'portal.clientConfig': clientConfigFixture(),
  };
}

export const handlers = createContractHandlers(defaultFixtures());

/** The public demo site: same fixtures, every write refused with `demo_read_only`. */
export const demoHandlers = (): HttpHandler[] =>
  createContractHandlers(
    {
      ...defaultFixtures(),
      // the visitor's clock (approval countdowns use the server offset) and the real version
      'me.me': () => ({ ...meFixture('admin'), serverTime: new Date().toISOString(), version: SYSTEM_INFO.version }),
      'me.badges': () => badgesFixture({ pendingApprovals: APPROVALS.length }),
    },
    { readOnly: true },
  );
