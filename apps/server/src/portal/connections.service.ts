import type { Kysely } from 'kysely';
import type { Connection } from '@neurouter/shared';
import type { AuditRecorder } from '../audit/recorder.js';
import type { MainDB } from '../db/schema.js';
import type { UserSubject } from '../identity/principal.js';
import { toIso, toIsoOrNull, type Clock } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import { loadAclPrincipal, type AclService } from '../policy/acl-cache.js';

/**
 * Per-user upstream OAuth connections (portal "Connections"): one row per per-user-OAuth server
 * the user can access (or already holds a token for). Connecting (authorize/callback/refresh)
 * is step 10; this lists state and disconnects.
 */
export class ConnectionsService {
  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly clock: Clock,
    private readonly acl: AclService,
    private readonly audit: AuditRecorder,
  ) {}

  static status(tok: { status: string; expires_at: number | null; refresh_ct: unknown } | null, now: number): Connection['status'] {
    if (!tok || tok.status === 'revoked') return 'not_connected';
    if (tok.status === 'refresh_failed') return 'error';
    if (tok.expires_at !== null && Number(tok.expires_at) <= now && !tok.refresh_ct) return 'expired';
    return 'connected';
  }

  async list(viewer: UserSubject): Promise<{ items: Connection[] }> {
    const now = this.clock.now();
    const servers = await this.db.selectFrom('servers').select(['id', 'name']).where('auth_mode', '=', 'user_oauth').where('enabled', '=', 1).where('status', '!=', 'disabled').orderBy('name').execute();
    if (!servers.length) return { items: [] };
    const [tokens, principal] = await Promise.all([
      this.db
        .selectFrom('user_upstream_tokens')
        .select(['server_id', 'status', 'expires_at', 'refresh_ct', 'scopes', 'created_at'])
        .where('user_id', '=', viewer.id)
        .where(
          'server_id',
          'in',
          servers.map((s) => s.id),
        )
        .execute(),
      loadAclPrincipal(this.db, viewer.id, null),
    ]);
    const decisions = await this.acl.explain(principal);
    const accessible = new Set(decisions.filter((d) => d.decision.decision === 'allow').map((d) => d.tool.serverId));
    const items: Connection[] = [];
    for (const s of servers) {
      const tok = tokens.find((t) => t.server_id === s.id) ?? null;
      if (!tok && !accessible.has(s.id)) continue;
      const status = ConnectionsService.status(tok, now);
      items.push({
        server: { id: s.id, name: s.name },
        status,
        accountLabel: null,
        scopes: tok?.scopes ? tok.scopes.split(/\s+/).filter(Boolean) : [],
        connectedAt: tok && status !== 'not_connected' ? toIso(Number(tok.created_at)) : null,
        expiresAt: tok ? toIsoOrNull(tok.expires_at) : null,
        error: status === 'error' ? 'Refreshing the upstream token failed; reconnect your account' : null,
      });
    }
    return { items };
  }

  async disconnect(serverId: string, viewer: UserSubject): Promise<void> {
    const res = await this.db.deleteFrom('user_upstream_tokens').where('user_id', '=', viewer.id).where('server_id', '=', serverId).executeTakeFirst();
    if (!Number(res.numDeletedRows)) throw AppError.notFound('Connection');
    this.audit.admin({ actorUserId: viewer.id, action: 'connection.disconnect', targetType: 'server', targetId: serverId });
  }
}
