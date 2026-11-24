import { Writable } from 'node:stream';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import type { Role } from '@neurouter/shared';
import { buildApp } from '../../app.js';
import { apiPlugins } from '../../api/plugin.js';
import type { AuditStore } from '../../audit/store.js';
import { loadConfig } from '../../config/load.js';
import { MemoryCoordination } from '../../coordination/memory.js';
import { createServices, initServices, type ServiceInputs, type Services } from '../../deps.js';
import type { Clock } from '../../lib/clock.js';
import { newId } from '../../lib/ids.js';
import { createLogger } from '../../lib/logger.js';
import { createTestDatabases } from './test-db.js';
import { disabledEmbedder } from '../../search/embedder.js';

export class FakeClock implements Clock {
  constructor(public t = Date.UTC(2026, 10, 24, 10, 0, 0)) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export interface TestUser {
  id: string;
  email: string;
  cookie: string;
  csrf: string;
}

export interface TestContext {
  app: FastifyInstance;
  s: Services;
  clock: Clock;
  logs: string[];
  /** Creates a user (with roles) and an authenticated web session. */
  user(email: string, roles?: Role[]): Promise<TestUser>;
  /** Injects with the user's session cookie and CSRF header. */
  as(u: TestUser | null, opts: InjectOptions): Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}

export async function createTestContext(opts: { env?: Record<string, string>; clock?: Clock; auditStore?: AuditStore } & Partial<Pick<ServiceInputs, 'oidcProvider' | 'upstreamFetch' | 'outboundFetch' | 'archive' | 'otelLogProvider' | 'embedder'>> & { extend?: (s: Services) => void } = {}): Promise<TestContext> {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'warn', PUBLIC_URL: 'http://gw.test', ...opts.env });
  const dbs = await createTestDatabases();
  const logs: string[] = [];
  const dest = new Writable({ write(chunk, _e, cb) { logs.push(String(chunk)); cb(); } });
  const logger = createLogger({ level: config.env.LOG_LEVEL, pretty: false }, dest as never);
  const clock = opts.clock ?? { now: () => Date.now() };
  const coordination = new MemoryCoordination(clock);
  const s = createServices({ config, logger, dbs, clock, coordination, version: '0.0.0-test', defaultMetrics: false,
    ...(opts.auditStore ? { auditStore: opts.auditStore } : {}),
    archive: opts.archive ?? null,
    ...(opts.otelLogProvider ? { otelLogProvider: opts.otelLogProvider } : {}),
    oidcProvider: opts.oidcProvider ?? null,
    // never load a real model in unit tests
    embedder: opts.embedder ?? disabledEmbedder(),
    upstreamFetch: opts.upstreamFetch ?? (() => async () => new Response('no upstream in this test', { status: 502 })),
    outboundFetch: opts.outboundFetch ?? (async () => new Response('no outbound in this test', { status: 502 })),
  });
  opts.extend?.(s);
  await initServices(s);
  const app = await buildApp({ config, logger, dbs, auditStore: s.auditStore, clock, version: '0.0.0-test', apiPlugins: apiPlugins(s) });
  await app.ready();

  const ctx: TestContext = {
    app,
    s,
    clock,
    logs,
    async user(email, roles = []) {
      const db = dbs.main.db;
      let row = await db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst();
      const now = clock.now();
      if (!row) {
        row = { id: newId() };
        await db.insertInto('users').values({ id: row.id, email, name: email.split('@')[0]!, oidc_issuer: null, oidc_subject: null, avatar_url: null, last_login_at: null, created_at: now, updated_at: now }).execute();
      }
      for (const role of roles) await db.insertInto('user_roles').values({ user_id: row.id, role, source: 'local', created_at: now, created_by: null }).onConflict((oc) => oc.doNothing()).execute();
      const sess = await s.sessions.create(row.id);
      return { id: row.id, email, cookie: `${config.cookieNames.session}=${sess.token}`, csrf: sess.csrfToken };
    },
    as(u, o) {
      const headers: Record<string, string> = { ...(o.headers as Record<string, string> | undefined) };
      if (u) {
        headers.cookie = u.cookie;
        headers['x-csrf-token'] ??= u.csrf;
      }
      return app.inject({ ...o, headers });
    },
    async close() {
      await app.close();
      await s.shutdown();
      await coordination.close();
      await dbs.close();
    },
  };
  return ctx;
}
