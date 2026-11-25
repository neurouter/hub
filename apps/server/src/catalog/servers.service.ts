import { sql, type Kysely, type SqlBool } from 'kysely';
import {
  can,
  isAdmin,
  type CreateServerBody,
  type CredentialsStatus,
  type ListServersQuery,
  type PutCredentialsBody,
  type ServerAuthIn,
  type ServerAuthInPartialSecret,
  type ServerAuthOut,
  type ServerDetail,
  type ServerRow,
  type TestConnectionBody,
  type TestConnectionResult,
  type UpdateServerBody,
} from '@neurouter/shared';
import type { AuditRecorder } from '../audit/recorder.js';
import type { MainDB, ServersTable } from '../db/schema.js';
import type { Clock } from '../lib/clock.js';
import { toIso, toIsoOrNull } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { fromBool, parseJsonColumn, toBool, toJsonColumn } from '../lib/json.js';
import { applyKeyset, containsCi, keysetPage, type KeysetSpec } from '../lib/keyset.js';
import { assertUrlAllowed, SsrfError, type NetPolicy } from '../lib/net/ssrf-guard.js';
import { clampLimit } from '../lib/pagination.js';
import type { SecretProvider } from '../secrets/provider.js';
import type { UserSubject } from '../identity/principal.js';
import type { UpstreamPool } from '../upstream/pool.js';
import type { UpstreamServerInfo } from '../upstream/client-factory.js';
import type { CatalogEvents } from './events.js';
import { iconPath } from './icons.js';

interface OauthConfig {
  discovery: 'auto' | 'manual';
  authorizationServerUrl: string | null;
  clientId: string | null;
  clientIdMode: 'cimd' | 'preregistered' | 'dcr';
  scopes: string[];
}

const OWNER_FIELDS = new Set(['name', 'description', 'tags', 'iconUrl', 'enabled', 'timeoutMs', 'syncIntervalMin', 'rateLimit', 'autoApproveNewTools']);
const HEALTH_ORDER = sql<string>`coalesce(h.status, 'unknown')`;

export interface ServersDeps {
  db: Kysely<MainDB>;
  clock: Clock;
  secrets: SecretProvider;
  audit: AuditRecorder;
  pool: UpstreamPool;
  events: CatalogEvents;
  upstreamPolicy: NetPolicy;
  publicUrl: string;
}

/** Servers, owners and write-only credentials (backend §14.3 "Admin: servers and tools"). */
export class ServersService {
  constructor(private readonly d: ServersDeps) {}

  private get db() {
    return this.d.db;
  }

  private assertUrl(url: string, path: string[] = ['url']): void {
    try {
      assertUrlAllowed(url, this.d.upstreamPolicy);
    } catch (err) {
      if (err instanceof SsrfError) throw AppError.validation('URL not allowed', [{ path, message: err.message, code: 'url_not_allowed' }]);
      throw err;
    }
  }

  /** Servers visible to the viewer for management: all for admin/auditor, owned for owners. */
  private scope(viewer: UserSubject) {
    const all = isAdmin(viewer) || viewer.roles.includes('auditor');
    return all ? sql<SqlBool>`1 = 1` : viewer.ownedServerIds.length ? sql<SqlBool>`s.id in (${sql.join(viewer.ownedServerIds)})` : sql<SqlBool>`1 = 0`;
  }

  private base() {
    return this.db
      .selectFrom('servers as s')
      .innerJoin('users as u', 'u.id', 's.owner_user_id')
      .leftJoin('server_health as h', 'h.server_id', 's.id')
      .selectAll('s')
      .select(['u.name as owner_name', 'h.status as health_status', 'h.latency_ms as health_latency', 'h.checked_at as health_checked_at']);
  }

  private async credentialKinds(ids: string[]) {
    if (!ids.length) return [];
    return this.db.selectFrom('server_credentials').select(['server_id', 'kind', 'header_name', 'secret_id', 'updated_at', 'rotated_at']).where('server_id', 'in', ids).execute();
  }

  private async counts(ids: string[]) {
    if (!ids.length) return [];
    return this.db
      .selectFrom('tools')
      .select([
        'server_id',
        sql<number>`sum(case when status != 'removed' then 1 else 0 end)`.as('total'),
        sql<number>`sum(case when status = 'active' and enabled = 1 then 1 else 0 end)`.as('enabled'),
        sql<number>`sum(case when status in ('pending_review', 'changed') then 1 else 0 end)`.as('pending'),
      ])
      .where('server_id', 'in', ids)
      .groupBy('server_id')
      .execute();
  }

  private authType(s: { auth_mode: string }, creds: { kind: string }[]): ServerAuthOut['type'] {
    if (s.auth_mode === 'none') return 'none';
    if (s.auth_mode === 'user_oauth') return 'per_user_oauth';
    return creds.some((c) => c.kind === 'shared_header') ? 'shared_header' : 'shared_bearer';
  }

  private async rows(raw: Awaited<ReturnType<ReturnType<ServersService['base']>['execute']>>): Promise<ServerRow[]> {
    const ids = raw.map((r) => r.id);
    const [creds, counts, icons] = await Promise.all([
      this.credentialKinds(ids),
      this.counts(ids),
      ids.length ? this.db.selectFrom('server_icons').select(['server_id', 'etag']).where('server_id', 'in', ids).where('error', 'is', null).execute() : [],
    ]);
    return raw.map((s) => {
      const c = counts.find((x) => x.server_id === s.id);
      return {
        id: s.id,
        slug: s.slug,
        name: s.name,
        url: s.url,
        transport: s.transport,
        authType: this.authType(s, creds.filter((x) => x.server_id === s.id)),
        owner: { id: s.owner_user_id, name: s.owner_name },
        trusted: toBool(s.trusted),
        enabled: toBool(s.enabled),
        status: s.status,
        health: { status: s.health_status ?? 'unknown', latencyMs: s.health_latency ?? null, checkedAt: toIsoOrNull(s.health_checked_at) },
        toolCount: Number(c?.total ?? 0),
        enabledToolCount: Number(c?.enabled ?? 0),
        pendingReviewCount: Number(c?.pending ?? 0),
        lastSyncAt: toIsoOrNull(s.last_synced_at),
        iconUrl: iconPath(s.id, icons.find((i) => i.server_id === s.id)),
      };
    });
  }

  async list(q: ListServersQuery, viewer: UserSubject): Promise<{ items: ServerRow[]; nextCursor: string | null }> {
    if (!can(viewer, 'servers:read')) throw AppError.forbidden();
    const limit = clampLimit(q.limit);
    let qb = this.base().where(this.scope(viewer));
    if (q.q) qb = qb.where((eb) => eb.or([containsCi(eb.ref('s.name'), q.q!), containsCi(eb.ref('s.slug'), q.q!), containsCi(eb.ref('s.url'), q.q!)]));
    if (q.status) qb = qb.where('s.status', '=', q.status);
    else qb = qb.where('s.status', '!=', 'disabled');
    if (q.ownerId) qb = qb.where('s.owner_user_id', '=', q.ownerId);
    const sort = q.sort ?? 'name';
    const spec: KeysetSpec =
      sort === 'createdAt'
        ? { sortExpr: sql<number>`s.created_at`, idExpr: sql<string>`s.id`, order: q.order ?? 'desc', kind: 'number' }
        : { sortExpr: sort === 'health' ? HEALTH_ORDER : sql<string>`lower(s.name)`, idExpr: sql<string>`s.id`, order: q.order ?? 'asc', kind: 'string' };
    const rows = await applyKeyset(qb, spec, q.cursor, limit).execute();
    const page = keysetPage(rows, limit, (r) => r, (r) => [sort === 'createdAt' ? r.created_at : sort === 'health' ? (r.health_status ?? 'unknown') : r.name.toLowerCase(), r.id]);
    return { items: await this.rows(page.items), nextCursor: page.nextCursor };
  }

  /** Loads a server the viewer may manage; 404 when outside their scope (no existence leak). */
  async loadForViewer(id: string, viewer: UserSubject) {
    const row = await this.base().where('s.id', '=', id).where(this.scope(viewer)).executeTakeFirst();
    if (!row) throw AppError.notFound('Server');
    return row;
  }

  async get(id: string, viewer: UserSubject): Promise<ServerDetail> {
    if (!can(viewer, 'servers:read')) throw AppError.forbidden();
    const s = await this.loadForViewer(id, viewer);
    const [row] = await this.rows([s]);
    const creds = await this.credentialKinds([id]);
    const oauth = parseJsonColumn<OauthConfig>(s.oauth_config);
    const authType = row!.authType;
    const secretCred = creds.find((c) => (authType === 'per_user_oauth' ? c.kind === 'oauth_client_secret' : c.kind !== 'oauth_client_secret'));
    const auth: ServerAuthOut = {
      type: authType,
      hasSecret: !!secretCred,
      secretUpdatedAt: toIsoOrNull(secretCred?.updated_at ?? null),
      ...(authType === 'shared_header' && secretCred?.header_name ? { headerName: secretCred.header_name } : {}),
      ...(authType === 'per_user_oauth'
        ? { oauth: { clientId: oauth?.clientId ?? null, clientIdMode: oauth?.clientIdMode ?? 'cimd', scopes: oauth?.scopes ?? [], callbackUrl: `${this.d.publicUrl}/oauth/upstream/callback` } }
        : {}),
    };
    const info = parseJsonColumn<UpstreamServerInfo>(s.server_info);
    const rl = parseJsonColumn<{ perToolPerMinute: number | null }>(s.rate_limit);
    const admin = isAdmin(viewer);
    const owner = viewer.ownedServerIds.includes(id);
    return {
      ...row!,
      description: s.description,
      tags: parseJsonColumn<string[]>(s.tags) ?? [],
      auth,
      timeoutMs: s.timeout_ms,
      syncIntervalMin: s.sync_interval_min,
      autoApproveNewTools: toBool(s.auto_approve_new_tools),
      pinningMode: s.pinning_mode,
      rateLimit: rl ? { perToolPerMinute: rl.perToolPerMinute ?? null } : null,
      detectedEra: s.detected_era,
      protocolVersion: s.protocol_version,
      serverInfo: info ? { name: info.name, version: info.version } : null,
      createdAt: toIso(s.created_at),
      updatedAt: toIso(s.updated_at),
      actions: admin
        ? ['update', 'delete', 'sync', 'health_check', 'manage_credentials', 'manage_grants', 'refresh_icon']
        : owner
          ? ['update', 'sync', 'health_check', 'manage_grants', 'refresh_icon']
          : [],
    };
  }

  /**
   * Stores the write-only secret(s) for an auth config. Not run inside a DB transaction: the
   * secret provider has its own connection usage (SQLite has a single connection).
   */
  private async storeAuth(trx: Kysely<MainDB>, serverId: string, auth: ServerAuthIn | ServerAuthInPartialSecret, now: number): Promise<{ authMode: ServersTable['auth_mode']; oauthConfig: OauthConfig | null }> {
    const existing = await trx.selectFrom('server_credentials').selectAll().where('server_id', '=', serverId).execute();
    const put = async (kind: 'shared_bearer' | 'shared_header' | 'oauth_client_secret', value: string | undefined, headerName: string | null) => {
      const cur = existing.find((c) => c.kind === kind);
      if (value === undefined) {
        if (!cur) throw AppError.validation('A secret is required', [{ path: ['auth', kind === 'shared_header' ? 'headerValue' : kind === 'shared_bearer' ? 'token' : 'clientSecret'], message: 'Required', code: 'required' }]);
        if (headerName !== null && cur.header_name !== headerName) await trx.updateTable('server_credentials').set({ header_name: headerName, updated_at: now }).where('id', '=', cur.id).execute();
        return;
      }
      const ref = await this.d.secrets.put({ purpose: 'server_credential', value: Buffer.from(value, 'utf8'), ...(cur ? { id: cur.secret_id } : {}) });
      if (cur) await trx.updateTable('server_credentials').set({ header_name: headerName, updated_at: now, rotated_at: now }).where('id', '=', cur.id).execute();
      else await trx.insertInto('server_credentials').values({ id: newId(), server_id: serverId, kind, header_name: headerName, secret_id: ref.id, created_at: now, updated_at: now, rotated_at: null }).execute();
    };
    const dropOthers = async (keep: string[]) => {
      for (const c of existing) {
        if (!keep.includes(c.kind)) {
          await trx.deleteFrom('server_credentials').where('id', '=', c.id).execute();
          await this.d.secrets.delete({ id: c.secret_id });
        }
      }
    };
    switch (auth.type) {
      case 'none':
        await dropOthers([]);
        return { authMode: 'none', oauthConfig: null };
      case 'shared_bearer':
        await put('shared_bearer', auth.token, null);
        await dropOthers(['shared_bearer']);
        return { authMode: 'shared', oauthConfig: null };
      case 'shared_header':
        await put('shared_header', auth.headerValue, auth.headerName);
        await dropOthers(['shared_header']);
        return { authMode: 'shared', oauthConfig: null };
      case 'per_user_oauth': {
        const o = auth.oauth;
        if (o.authorizationServerUrl) this.assertUrl(o.authorizationServerUrl, ['auth', 'oauth', 'authorizationServerUrl']);
        if (o.clientSecret !== undefined || existing.some((c) => c.kind === 'oauth_client_secret')) {
          if (o.clientSecret !== undefined) await put('oauth_client_secret', o.clientSecret, null);
        }
        await dropOthers(['oauth_client_secret']);
        return {
          authMode: 'user_oauth',
          oauthConfig: { discovery: o.discovery, authorizationServerUrl: o.authorizationServerUrl ?? null, clientId: o.clientId ?? null, clientIdMode: o.clientId ? 'preregistered' : 'cimd', scopes: o.scopes },
        };
      }
    }
  }

  async create(body: CreateServerBody, actor: UserSubject): Promise<string> {
    if (!can(actor, 'servers:create')) throw AppError.forbidden();
    this.assertUrl(body.url);
    const owner = await this.db.selectFrom('users').select(['id', 'status']).where('id', '=', body.ownerId).executeTakeFirst();
    if (!owner || owner.status !== 'active') throw AppError.validation('Unknown owner', [{ path: ['ownerId'], message: 'User not found or disabled', code: 'not_found' }]);
    if (await this.db.selectFrom('servers').select('id').where('slug', '=', body.slug).executeTakeFirst()) throw AppError.conflict(`Slug "${body.slug}" is already in use`);
    const id = newId();
    const now = this.d.clock.now();
    const trx = this.db;
    await trx
        .insertInto('servers')
        .values({
          id,
          slug: body.slug,
          name: body.name,
          owner_user_id: body.ownerId,
          description: body.description ?? '',
          url: body.url,
          transport: body.transport,
          auth_mode: 'none',
          trusted: fromBool(body.trusted ?? false),
          enabled: 1,
          tags: toJsonColumn(body.tags ?? []),
          icon_url: body.iconUrl ?? null,
          timeout_ms: body.timeoutMs ?? 60_000,
          sync_interval_min: body.syncIntervalMin ?? null,
          auto_approve_new_tools: fromBool(body.autoApproveNewTools ?? false),
          pinning_mode: body.pinningMode ?? 'strict',
          oauth_config: null,
          rate_limit: null,
          detected_era: null,
          protocol_version: null,
          server_info: null,
          capabilities: null,
          last_synced_at: null,
          created_by: actor.id,
          created_at: now,
          updated_at: now,
        })
        .execute();
    try {
      const a = await this.storeAuth(trx, id, body.auth, now);
      await trx.updateTable('servers').set({ auth_mode: a.authMode, oauth_config: a.oauthConfig ? toJsonColumn(a.oauthConfig) : null }).where('id', '=', id).execute();
      await trx.insertInto('server_health').values({ server_id: id, status: 'unknown', latency_ms: null, checked_at: null, error: null, consecutive_failures: 0 }).execute();
    } catch (err) {
      // compensate: no half-configured server
      await this.storeAuth(trx, id, { type: 'none' }, now).catch(() => {});
      await trx.deleteFrom('server_health').where('server_id', '=', id).execute();
      await trx.deleteFrom('servers').where('id', '=', id).execute();
      throw err;
    }
    this.d.audit.admin({ actorUserId: actor.id, action: 'server.create', targetType: 'server', targetId: id, after: redactAuth(body) });
    await this.d.events.serversChanged();
    return id;
  }

  async update(id: string, body: UpdateServerBody, actor: UserSubject): Promise<void> {
    const s = await this.loadForViewer(id, actor);
    const admin = isAdmin(actor);
    if (!admin && !(actor.ownedServerIds.includes(id) && can(actor, 'servers:write', { serverId: id }))) throw AppError.forbidden();
    const adminOnly = Object.keys(body).filter((k) => (body as Record<string, unknown>)[k] !== undefined && !OWNER_FIELDS.has(k));
    if (!admin && adminOnly.length) throw AppError.forbidden(`Only admins can change ${adminOnly.join(', ')}`);
    if (body.url) this.assertUrl(body.url);
    if (body.slug && body.slug !== s.slug) {
      const hasTools = await this.db.selectFrom('tools').select('id').where('server_id', '=', id).limit(1).executeTakeFirst();
      if (hasTools) throw AppError.conflict('The slug cannot change once the server has tools (exposed tool names depend on it); re-create the server instead');
      if (await this.db.selectFrom('servers').select('id').where('slug', '=', body.slug).executeTakeFirst()) throw AppError.conflict(`Slug "${body.slug}" is already in use`);
    }
    if (body.ownerId) {
      const owner = await this.db.selectFrom('users').select(['id', 'status']).where('id', '=', body.ownerId).executeTakeFirst();
      if (!owner || owner.status !== 'active') throw AppError.validation('Unknown owner', [{ path: ['ownerId'], message: 'User not found or disabled', code: 'not_found' }]);
    }
    const now = this.d.clock.now();
    const patch: Record<string, unknown> = { updated_at: now };
    if (body.name !== undefined) patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description;
    if (body.tags !== undefined) patch.tags = toJsonColumn(body.tags);
    if (body.iconUrl !== undefined) patch.icon_url = body.iconUrl;
    if (body.enabled !== undefined) patch.enabled = fromBool(body.enabled);
    if (body.timeoutMs !== undefined) patch.timeout_ms = body.timeoutMs;
    if (body.syncIntervalMin !== undefined) patch.sync_interval_min = body.syncIntervalMin;
    if (body.rateLimit !== undefined) patch.rate_limit = body.rateLimit ? toJsonColumn(body.rateLimit) : null;
    if (body.autoApproveNewTools !== undefined) patch.auto_approve_new_tools = fromBool(body.autoApproveNewTools);
    if (body.pinningMode !== undefined) patch.pinning_mode = body.pinningMode;
    if (body.url !== undefined) patch.url = body.url;
    if (body.transport !== undefined) patch.transport = body.transport;
    if (body.trusted !== undefined) patch.trusted = fromBool(body.trusted);
    if (body.ownerId !== undefined) patch.owner_user_id = body.ownerId;
    if (body.slug !== undefined) patch.slug = body.slug;
    const connectionChanged = body.url !== undefined || body.transport !== undefined || body.auth !== undefined;
    if (connectionChanged) {
      patch.detected_era = null;
      patch.protocol_version = null;
    }
    if (body.auth) {
      const a = await this.storeAuth(this.db, id, body.auth, now);
      patch.auth_mode = a.authMode;
      patch.oauth_config = a.oauthConfig ? toJsonColumn(a.oauthConfig) : null;
    }
    await this.db.updateTable('servers').set(patch as never).where('id', '=', id).execute();
    if (connectionChanged) this.d.pool.invalidate(id);
    const before = { name: s.name, enabled: toBool(s.enabled), url: s.url, transport: s.transport, ownerId: s.owner_user_id, slug: s.slug };
    this.d.audit.admin({ actorUserId: actor.id, action: 'server.update', targetType: 'server', targetId: id, before, after: redactAuth(body) });
    await this.d.events.serversChanged();
  }

  /** Soft delete: disabled, tools blocked, audit kept. */
  async delete(id: string, actor: UserSubject): Promise<void> {
    if (!isAdmin(actor)) throw AppError.forbidden();
    const s = await this.loadForViewer(id, actor);
    await this.db.updateTable('servers').set({ status: 'disabled', enabled: 0, updated_at: this.d.clock.now() }).where('id', '=', id).execute();
    this.d.pool.invalidate(id);
    this.d.audit.admin({ actorUserId: actor.id, action: 'server.delete', targetType: 'server', targetId: id, before: { name: s.name, slug: s.slug } });
    await this.d.events.serversChanged();
  }

  async putCredentials(id: string, body: PutCredentialsBody, actor: UserSubject): Promise<CredentialsStatus> {
    if (!isAdmin(actor)) throw AppError.forbidden();
    const s = await this.loadForViewer(id, actor);
    const creds = await this.credentialKinds([id]);
    const type = this.authType(s, creds);
    const now = this.d.clock.now();
    let kind: 'shared_bearer' | 'shared_header' | 'oauth_client_secret';
    let value: string;
    if ('token' in body) [kind, value] = ['shared_bearer', body.token];
    else if ('headerValue' in body) [kind, value] = ['shared_header', body.headerValue];
    else [kind, value] = ['oauth_client_secret', body.oauth.clientSecret];
    const expected = type === 'shared_bearer' ? 'shared_bearer' : type === 'shared_header' ? 'shared_header' : type === 'per_user_oauth' ? 'oauth_client_secret' : null;
    if (kind !== expected) throw AppError.conflict(`This server uses ${type} auth; that credential does not apply`);
    const cur = creds.find((c) => c.kind === kind);
    if (cur) {
      await this.d.secrets.put({ id: cur.secret_id, purpose: 'server_credential', value: Buffer.from(value, 'utf8') });
      await this.db.updateTable('server_credentials').set({ updated_at: now, rotated_at: now }).where('server_id', '=', id).where('kind', '=', kind).execute();
    } else {
      if (kind === 'shared_header') throw AppError.conflict('Set the header name by updating the server auth first');
      const ref = await this.d.secrets.put({ purpose: 'server_credential', value: Buffer.from(value, 'utf8') });
      await this.db.insertInto('server_credentials').values({ id: newId(), server_id: id, kind, header_name: null, secret_id: ref.id, created_at: now, updated_at: now, rotated_at: null }).execute();
    }
    this.d.pool.invalidate(id);
    this.d.audit.admin({ actorUserId: actor.id, action: 'server.credentials.update', targetType: 'server', targetId: id, after: { kind } });
    return { hasSecret: true, secretUpdatedAt: toIso(now) };
  }

  /** Dry-run connect. Never throws for upstream failures: `ok:false` with an error code. */
  async testConnection(body: TestConnectionBody, actor: UserSubject): Promise<TestConnectionResult> {
    if (body.serverId) {
      await this.loadForViewer(body.serverId, actor);
      if (!isAdmin(actor) && !actor.ownedServerIds.includes(body.serverId)) throw AppError.forbidden();
    } else if (!isAdmin(actor)) {
      throw AppError.forbidden();
    }
    this.assertUrl(body.url);
    const start = performance.now();
    let headers: Record<string, string> = {};
    const auth = body.auth;
    const stored = body.serverId ? await this.credentialKinds([body.serverId]) : [];
    const storedValue = async (kind: string) => {
      const c = stored.find((x) => x.kind === kind);
      return c ? (await this.d.secrets.get({ id: c.secret_id })).toString('utf8') : undefined;
    };
    if (auth.type === 'shared_bearer') {
      const token = auth.token ?? (await storedValue('shared_bearer'));
      if (!token) throw AppError.validation('A token is required', [{ path: ['auth', 'token'], message: 'Required', code: 'required' }]);
      headers = { authorization: `Bearer ${token}` };
    } else if (auth.type === 'shared_header') {
      const v = auth.headerValue ?? (await storedValue('shared_header'));
      if (!v) throw AppError.validation('A header value is required', [{ path: ['auth', 'headerValue'], message: 'Required', code: 'required' }]);
      headers = { [auth.headerName.toLowerCase()]: v };
    }
    try {
      const r = await this.d.pool.probe({ id: body.serverId ?? 'test', name: 'test', url: body.url, transport: body.transport, authMode: 'none', timeoutMs: 10_000, headers }, { timeoutMs: 10_000, listTools: auth.type !== 'per_user_oauth' });
      return { ok: true, protocolVersion: r.protocolVersion, era: r.era, serverInfo: r.serverInfo ? { name: r.serverInfo.name, version: r.serverInfo.version } : null, toolCount: r.toolCount, latencyMs: Math.round(performance.now() - start), authRequired: auth.type === 'per_user_oauth', error: null };
    } catch (err) {
      const e = err as { kind?: string; message: string };
      const authRequired = e.kind === 'auth_required';
      return {
        ok: authRequired && auth.type === 'per_user_oauth',
        protocolVersion: null,
        era: null,
        serverInfo: null,
        toolCount: null,
        latencyMs: Math.round(performance.now() - start),
        authRequired,
        error: authRequired && auth.type === 'per_user_oauth' ? null : { code: e.kind ?? 'transport', message: e.message.slice(0, 300) },
      };
    }
  }

  /** Persist the detected protocol era (pool callback). */
  async recordEra(serverId: string, info: { era: string; protocolVersion: string | null; serverInfo: UpstreamServerInfo | null }): Promise<void> {
    await this.db
      .updateTable('servers')
      .set({ detected_era: info.era as 'modern' | 'legacy' | 'legacy_sse', protocol_version: info.protocolVersion, server_info: info.serverInfo ? toJsonColumn(info.serverInfo) : null })
      .where('id', '=', serverId)
      .execute();
  }
}

/** Audit `changes` never contain secrets. */
function redactAuth<T extends { auth?: unknown }>(body: T): T {
  if (!body.auth || typeof body.auth !== 'object') return body;
  const a = { ...(body.auth as Record<string, unknown>) };
  for (const k of ['token', 'headerValue']) if (k in a) a[k] = { $redacted: 'secret' };
  if (a.oauth && typeof a.oauth === 'object' && 'clientSecret' in (a.oauth as object)) a.oauth = { ...(a.oauth as object), clientSecret: { $redacted: 'secret' } };
  return { ...body, auth: a };
}
