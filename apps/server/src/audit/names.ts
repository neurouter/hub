import type { Kysely } from 'kysely';
import type { MainDB } from '../db/schema.js';

export const DELETED = '(deleted)';

export interface NameMaps {
  users: Map<string, { name: string; email: string }>;
  agents: Map<string, string>;
  servers: Map<string, { name: string; slug: string }>;
  tools: Map<string, { upstreamName: string; exposedName: string; serverId: string }>;
}

const uniq = (xs: Iterable<string | null | undefined>) => [...new Set([...xs].filter((x): x is string => typeof x === 'string' && x.length > 0))];

/**
 * Batch id → display-name lookups against the control-plane DB. Audit, sessions and rollups
 * live in the audit DB (possibly another database), so names are resolved here, never joined.
 */
export class NameResolver {
  constructor(private readonly db: Kysely<MainDB>) {}

  async load(ids: { users?: Iterable<string | null>; agents?: Iterable<string | null>; servers?: Iterable<string | null>; tools?: Iterable<string | null> }): Promise<NameMaps> {
    const u = uniq(ids.users ?? []);
    const a = uniq(ids.agents ?? []);
    const s = uniq(ids.servers ?? []);
    const t = uniq(ids.tools ?? []);
    const [users, agents, servers, tools] = await Promise.all([
      u.length ? this.db.selectFrom('users').select(['id', 'name', 'email']).where('id', 'in', u).execute() : [],
      a.length ? this.db.selectFrom('agents').select(['id', 'name']).where('id', 'in', a).execute() : [],
      s.length ? this.db.selectFrom('servers').select(['id', 'name', 'slug']).where('id', 'in', s).execute() : [],
      t.length ? this.db.selectFrom('tools').select(['id', 'upstream_name', 'exposed_name', 'server_id']).where('id', 'in', t).execute() : [],
    ]);
    return {
      users: new Map(users.map((r) => [r.id, { name: r.name || r.email, email: r.email }])),
      agents: new Map(agents.map((r) => [r.id, r.name])),
      servers: new Map(servers.map((r) => [r.id, { name: r.name, slug: r.slug }])),
      tools: new Map(tools.map((r) => [r.id, { upstreamName: r.upstream_name, exposedName: r.exposed_name, serverId: r.server_id }])),
    };
  }

  /** Display name of an admin-event target. */
  async targetName(type: string | null, id: string | null): Promise<string | null> {
    if (!type || !id) return null;
    const one = async (q: Promise<{ n: string } | undefined>) => (await q)?.n ?? null;
    switch (type) {
      case 'server':
        return one(this.db.selectFrom('servers').select('name as n').where('id', '=', id).executeTakeFirst());
      case 'tool':
        return one(this.db.selectFrom('tools').select('exposed_name as n').where('id', '=', id).executeTakeFirst());
      case 'user':
        return one(this.db.selectFrom('users').select('email as n').where('id', '=', id).executeTakeFirst());
      case 'group':
        return one(this.db.selectFrom('groups').select('name as n').where('id', '=', id).executeTakeFirst());
      case 'agent':
        return one(this.db.selectFrom('agents').select('name as n').where('id', '=', id).executeTakeFirst());
      case 'redaction_rule':
        return one(this.db.selectFrom('redaction_rules').select('name as n').where('id', '=', id).executeTakeFirst());
      default:
        return null;
    }
  }
}

/** Upstream tool name from an exposed `<slug>__<name>` when the tool row is gone. */
export function upstreamNameOf(exposed: string): string {
  const i = exposed.indexOf('__');
  return i >= 0 ? exposed.slice(i + 2) : exposed;
}
