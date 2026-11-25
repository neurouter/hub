import { EVERYONE_GROUP_ID } from '@neurouter/shared';
import type { Kysely } from 'kysely';
import type { CoordinationStore } from '../../coordination/types.js';
import type { MainDB } from '../../db/schema.js';
import type { Clock } from '../../lib/clock.js';
import { hmacSha256, sha256 } from '../../lib/crypto.js';
import { parseJsonColumn, toBool } from '../../lib/json.js';
import { parseApiKey, verifySecret } from '../../identity/api-key-format.js';
import { AUTH_REVOKED_CHANNEL } from '../../identity/users.service.js';
import { ACL_CHANGED } from '../../policy/acl-cache.js';

export const MCP_SCOPE = 'mcp:tools';

/** The authenticated caller of `/mcp` (backend §5.3). */
export interface McpPrincipal {
  user: { id: string; email: string; name: string };
  groupIds: string[];
  agent: { id: string; name: string; narrowed: boolean; rateLimit: { perMinute: number; burst: number } | null };
  authMethod: 'api_key' | 'oauth';
  /** api_keys.id or oauth_tokens.id */
  credentialId: string;
  oauthClientId: string | null;
  scopes: string[];
}

export type AuthOutcome =
  | { ok: true; principal: McpPrincipal }
  | { ok: false; error: 'missing_token' | 'invalid_token' | 'insufficient_scope'; reason: string };

/**
 * Bearer authentication for `/mcp` (backend §5.2): `nr_live_…` API keys (HMAC with pepper,
 * constant-time) and `nr_at_…` OAuth access tokens (audience-bound to the resource URI).
 * Results are cached for 30 s; any `auth.revoked` / `acl.changed` event clears the cache.
 */
export class McpAuthenticator {
  private readonly cache = new Map<string, { at: number; outcome: AuthOutcome }>();
  private readonly lastTouched = new Map<string, number>();

  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly clock: Clock,
    private readonly opts: { pepper: string; resourceUri: string; cacheTtlMs?: number },
    coord?: CoordinationStore,
  ) {
    coord?.subscribe(AUTH_REVOKED_CHANNEL, () => this.cache.clear());
    coord?.subscribe(ACL_CHANGED, () => this.cache.clear());
    coord?.subscribe('resync', () => this.cache.clear());
  }

  clearCache(): void {
    this.cache.clear();
  }

  async authenticate(authorization: string | undefined, meta: { ip?: string | null } = {}): Promise<AuthOutcome> {
    if (!authorization) return { ok: false, error: 'missing_token', reason: 'no Authorization header' };
    const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
    if (!m) return { ok: false, error: 'invalid_token', reason: 'not a Bearer token' };
    const token = m[1]!;
    const key = sha256(token).toString('base64url');
    const now = this.clock.now();
    const hit = this.cache.get(key);
    let outcome: AuthOutcome;
    if (hit && now - hit.at < (this.opts.cacheTtlMs ?? 30_000)) {
      outcome = hit.outcome;
    } else {
      outcome = token.startsWith('nr_live_') ? await this.apiKey(token, now) : token.startsWith('nr_at_') ? await this.oauthToken(token, now) : { ok: false, error: 'invalid_token', reason: 'unknown token format' };
      if (this.cache.size > 10_000) this.cache.clear();
      this.cache.set(key, { at: now, outcome });
    }
    if (outcome.ok) this.touch(outcome.principal, now, meta.ip ?? null);
    return outcome;
  }

  private async loadPrincipal(agentId: string, authMethod: McpPrincipal['authMethod'], credentialId: string, scopes: string[]): Promise<AuthOutcome> {
    const a = await this.db
      .selectFrom('agents as a')
      .innerJoin('users as u', 'u.id', 'a.owner_user_id')
      .select(['a.id', 'a.name', 'a.narrowed', 'a.rate_limit', 'a.status', 'a.oauth_client_id', 'u.id as uid', 'u.email', 'u.name as uname', 'u.status as ustatus'])
      .where('a.id', '=', agentId)
      .executeTakeFirst();
    if (!a || a.status !== 'active') return { ok: false, error: 'invalid_token', reason: 'agent inactive' };
    if (a.ustatus !== 'active') return { ok: false, error: 'invalid_token', reason: 'owner disabled' };
    const groups = await this.db.selectFrom('group_memberships').select('group_id').where('user_id', '=', a.uid).execute();
    return {
      ok: true,
      principal: {
        user: { id: a.uid, email: a.email, name: a.uname },
        groupIds: [EVERYONE_GROUP_ID, ...groups.map((g) => g.group_id)],
        agent: { id: a.id, name: a.name, narrowed: toBool(a.narrowed), rateLimit: parseJsonColumn(a.rate_limit) },
        authMethod,
        credentialId,
        oauthClientId: a.oauth_client_id,
        scopes,
      },
    };
  }

  private async apiKey(token: string, now: number): Promise<AuthOutcome> {
    const parsed = parseApiKey(token);
    if (!parsed) return { ok: false, error: 'invalid_token', reason: 'malformed api key' };
    const k = await this.db.selectFrom('api_keys').selectAll().where('key_id', '=', parsed.keyId).executeTakeFirst();
    if (!k || !verifySecret(this.opts.pepper, parsed.secret, k.secret_hash)) return { ok: false, error: 'invalid_token', reason: 'unknown api key' };
    if (k.revoked_at !== null) return { ok: false, error: 'invalid_token', reason: 'api key revoked' };
    if (k.expires_at !== null && k.expires_at <= now) return { ok: false, error: 'invalid_token', reason: 'api key expired' };
    return this.loadPrincipal(k.agent_id, 'api_key', k.id, [MCP_SCOPE]);
  }

  private async oauthToken(token: string, now: number): Promise<AuthOutcome> {
    const t = await this.db.selectFrom('oauth_tokens').selectAll().where('token_hash', '=', hmacSha256(this.opts.pepper, token)).where('kind', '=', 'access').executeTakeFirst();
    if (!t || t.revoked_at !== null || t.expires_at <= now) return { ok: false, error: 'invalid_token', reason: 'unknown, revoked or expired token' };
    if (!sameResource(t.resource, this.opts.resourceUri)) return { ok: false, error: 'invalid_token', reason: 'token audience mismatch' };
    const scopes = t.scopes.split(/\s+/).filter(Boolean);
    if (!scopes.includes(MCP_SCOPE)) return { ok: false, error: 'insufficient_scope', reason: `missing scope ${MCP_SCOPE}` };
    const client = await this.db.selectFrom('oauth_clients').select('status').where('id', '=', t.client_id).executeTakeFirst();
    if (client?.status === 'blocked') return { ok: false, error: 'invalid_token', reason: 'client blocked' };
    return this.loadPrincipal(t.agent_id, 'oauth', t.id, scopes);
  }

  /** `last_used_at` / `last_seen_at` updated asynchronously, at most once a minute per credential. */
  private touch(p: McpPrincipal, now: number, ip: string | null): void {
    const last = this.lastTouched.get(p.credentialId) ?? 0;
    if (now - last < 60_000) return;
    this.lastTouched.set(p.credentialId, now);
    if (this.lastTouched.size > 50_000) this.lastTouched.clear();
    const work = async () => {
      if (p.authMethod === 'api_key') await this.db.updateTable('api_keys').set({ last_used_at: now, last_used_ip: ip }).where('id', '=', p.credentialId).execute();
      else await this.db.updateTable('oauth_tokens').set({ last_used_at: now }).where('id', '=', p.credentialId).execute();
      await this.db.updateTable('agents').set({ last_seen_at: now }).where('id', '=', p.agent.id).execute();
    };
    void work().catch(() => {});
  }
}

/** RFC 8707 audience check; tolerate a differently-cased host (spec robustness). */
export function sameResource(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.protocol === y.protocol && x.host.toLowerCase() === y.host.toLowerCase() && x.pathname.replace(/\/$/, '') === y.pathname.replace(/\/$/, '') && x.search === y.search;
  } catch {
    return false;
  }
}
