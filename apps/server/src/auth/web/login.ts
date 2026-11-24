import type { Kysely } from 'kysely';
import * as oidc from 'openid-client';
import { isSafeReturnTo, type LoginErrorCode } from '@neurouter/shared';
import type { AuditRecorder } from '../../audit/recorder.js';
import type { MainDB } from '../../db/schema.js';
import type { Clock } from '../../lib/clock.js';
import { sha256 } from '../../lib/crypto.js';
import { newId } from '../../lib/ids.js';
import { pack, unpack } from '../../secrets/envelope.js';
import type { EnvelopeService } from '../../secrets/envelope.service.js';
import type { SettingsService } from '../../settings/settings.service.js';
import { syncOidcGroups } from '../../identity/group-sync.js';
import { reconcileRoles, rolesFromMappings } from '../../identity/roles.js';
import type { OidcProvider } from './oidc.js';

export interface LoginConfig {
  redirectUri: string;
  scopes: string;
  groupsClaim: string;
  autoCreateGroups: boolean;
  allowedEmailDomains: readonly string[];
  bootstrapAdminEmail: string | null;
}

export type LoginOutcome = { ok: true; userId: string; returnTo: string; idToken: string | null } | { ok: false; error: Exclude<LoginErrorCode, 'session_expired'>; reason: string };

const STATE_TTL_MS = 10 * 60_000;
const stateAad = (stateHashHex: string) => `neurouter:oidc-state:${stateHashHex}`;

/**
 * OIDC + dev login (backend §7.1): state/nonce/PKCE, user upsert, group + role sync,
 * bootstrap admin. Sessions are created by the route after a successful outcome.
 */
export class LoginService {
  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly clock: Clock,
    private readonly envelope: EnvelopeService,
    private readonly settings: SettingsService,
    private readonly audit: AuditRecorder,
    private readonly cfg: LoginConfig,
    private readonly provider: OidcProvider | null,
  ) {}

  get oidcEnabled(): boolean {
    return this.provider !== null;
  }

  async start(returnTo: string | undefined): Promise<string> {
    if (!this.provider) throw new Error('OIDC is not configured');
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const verifier = oidc.randomPKCECodeVerifier();
    const challenge = await oidc.calculatePKCECodeChallenge(verifier);
    const stateHash = sha256(state);
    const sealed = await this.envelope.seal(Buffer.from(verifier), stateAad(stateHash.toString('hex')));
    await this.db
      .insertInto('oidc_login_states')
      .values({
        state_hash: stateHash,
        // dek id ‖ nonce ‖ ciphertext so the verifier stays decryptable after DEK rotation
        code_verifier_enc: Buffer.concat([Buffer.from(sealed.dekId.padEnd(36).slice(0, 36)), pack(sealed)]),
        nonce,
        return_to: isSafeReturnTo(returnTo) ? returnTo : '/',
        expires_at: this.clock.now() + STATE_TTL_MS,
      })
      .execute();
    return this.provider.authorizationUrl({ redirectUri: this.cfg.redirectUri, scope: this.cfg.scopes, state, nonce, codeChallenge: challenge });
  }

  async finish(currentUrl: URL, meta: { ip?: string | null; userAgent?: string | null } = {}): Promise<LoginOutcome> {
    const fail = (error: Exclude<LoginErrorCode, 'session_expired'>, reason: string, userId: string | null = null): LoginOutcome => {
      this.audit.auth({ userId, action: 'auth.login', status: 'blocked', reason, ip: meta.ip ?? null, userAgent: meta.userAgent ?? null });
      return { ok: false, error, reason };
    };
    if (!this.provider) return fail('idp_error', 'oidc_not_configured');
    const state = currentUrl.searchParams.get('state');
    if (!state) return fail('idp_error', 'missing_state');
    const stateHash = sha256(state);
    const row = await this.db.selectFrom('oidc_login_states').selectAll().where('state_hash', '=', stateHash).executeTakeFirst();
    if (!row) return fail('idp_error', 'unknown_state');
    await this.db.deleteFrom('oidc_login_states').where('state_hash', '=', stateHash).execute();
    if (row.expires_at <= this.clock.now()) return fail('idp_error', 'state_expired');
    const idpError = currentUrl.searchParams.get('error');
    if (idpError) return fail(idpError === 'access_denied' ? 'access_denied' : 'idp_error', `idp:${idpError.slice(0, 64)}`);

    let verifier: string;
    try {
      const dekId = row.code_verifier_enc.subarray(0, 36).toString().trim();
      const sealed = unpack(row.code_verifier_enc.subarray(36));
      verifier = (await this.envelope.open({ dekId, ...sealed }, stateAad(stateHash.toString('hex')))).toString();
    } catch {
      return fail('idp_error', 'state_decrypt_failed');
    }

    let claims: Record<string, unknown>;
    let idToken: string | null;
    try {
      ({ claims, idToken } = await this.provider.callback(currentUrl, { codeVerifier: verifier, state, nonce: row.nonce }));
    } catch (err) {
      return fail('idp_error', `callback_failed:${(err as Error).message.slice(0, 120)}`);
    }

    const sub = typeof claims.sub === 'string' ? claims.sub : null;
    const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : null;
    if (!sub || !email) return fail('access_denied', 'missing_sub_or_email');
    // Users without a verified email are rejected unless the IdP doesn't emit email_verified.
    const verified = claims.email_verified === undefined ? true : claims.email_verified === true || claims.email_verified === 'true';
    if (!verified) return fail('access_denied', 'email_not_verified');
    if (!this.domainAllowed(email)) return fail('access_denied', 'email_domain_not_allowed');

    const name = typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim().slice(0, 200) : email.split('@')[0]!;
    const picture = typeof claims.picture === 'string' && claims.picture.startsWith('https://') ? claims.picture.slice(0, 2048) : null;
    const up = await this.upsertUser({ issuer: this.provider.issuer, subject: sub, email, name, avatarUrl: picture });
    if (!up.ok) return fail(up.error, up.reason, up.userId ?? null);
    const userId = up.userId;
    const now = this.clock.now();

    await syncOidcGroups(this.db, { userId, claims, groupsClaim: this.cfg.groupsClaim, autoCreate: this.cfg.autoCreateGroups, now });
    const roleMappings = await this.settings.get('oidcRoleMappings');
    await reconcileRoles(this.db, userId, 'oidc', rolesFromMappings(claims, roleMappings), now);
    await this.applyBootstrap(userId, email, verified);
    await this.db.updateTable('users').set({ last_login_at: now, updated_at: now }).where('id', '=', userId).execute();
    this.audit.auth({ userId, action: 'auth.login', reason: 'oidc', ip: meta.ip ?? null, userAgent: meta.userAgent ?? null });
    return { ok: true, userId, returnTo: row.return_to, idToken };
  }

  /** `AUTH_DEV_LOGIN` (development only): upsert by email and apply the bootstrap rule. */
  async devLogin(emailIn: string, nameIn: string | undefined, meta: { ip?: string | null; userAgent?: string | null } = {}): Promise<LoginOutcome> {
    const email = emailIn.trim().toLowerCase();
    const name = nameIn?.trim() || email.split('@')[0]!;
    const existing = await this.db.selectFrom('users').select(['id', 'status']).where('email', '=', email).executeTakeFirst();
    let userId: string;
    if (existing) {
      if (existing.status !== 'active') return { ok: false, error: 'disabled', reason: 'user_disabled' };
      userId = existing.id;
    } else {
      userId = newId();
      const now = this.clock.now();
      await this.db.insertInto('users').values({ id: userId, email, name, oidc_issuer: null, oidc_subject: null, avatar_url: null, last_login_at: null, created_at: now, updated_at: now }).execute();
    }
    await this.applyBootstrap(userId, email, true);
    const now = this.clock.now();
    await this.db.updateTable('users').set({ last_login_at: now, updated_at: now }).where('id', '=', userId).execute();
    this.audit.auth({ userId, action: 'auth.login', reason: 'dev', ip: meta.ip ?? null, userAgent: meta.userAgent ?? null });
    return { ok: true, userId, returnTo: '/', idToken: null };
  }

  private domainAllowed(email: string): boolean {
    if (this.cfg.allowedEmailDomains.length === 0) return true;
    const domain = email.slice(email.lastIndexOf('@') + 1);
    return this.cfg.allowedEmailDomains.some((d) => d.toLowerCase() === domain);
  }

  /** Upsert by (issuer, sub); link a pre-provisioned user by email when it has no OIDC subject yet. */
  private async upsertUser(p: { issuer: string; subject: string; email: string; name: string; avatarUrl: string | null }): Promise<{ ok: true; userId: string } | { ok: false; error: 'disabled' | 'access_denied'; reason: string; userId?: string }> {
    const now = this.clock.now();
    const bySub = await this.db.selectFrom('users').select(['id', 'status']).where('oidc_issuer', '=', p.issuer).where('oidc_subject', '=', p.subject).executeTakeFirst();
    if (bySub) {
      if (bySub.status !== 'active') return { ok: false, error: 'disabled', reason: 'user_disabled', userId: bySub.id };
      const clash = await this.db.selectFrom('users').select('id').where('email', '=', p.email).where('id', '!=', bySub.id).executeTakeFirst();
      await this.db
        .updateTable('users')
        .set({ ...(clash ? {} : { email: p.email }), name: p.name, avatar_url: p.avatarUrl, updated_at: now })
        .where('id', '=', bySub.id)
        .execute();
      return { ok: true, userId: bySub.id };
    }
    const byEmail = await this.db.selectFrom('users').select(['id', 'status', 'oidc_subject']).where('email', '=', p.email).executeTakeFirst();
    if (byEmail) {
      if (byEmail.oidc_subject !== null) return { ok: false, error: 'access_denied', reason: 'email_linked_to_other_subject', userId: byEmail.id };
      if (byEmail.status !== 'active') return { ok: false, error: 'disabled', reason: 'user_disabled', userId: byEmail.id };
      await this.db.updateTable('users').set({ oidc_issuer: p.issuer, oidc_subject: p.subject, name: p.name, avatar_url: p.avatarUrl, updated_at: now }).where('id', '=', byEmail.id).execute();
      return { ok: true, userId: byEmail.id };
    }
    const id = newId();
    await this.db.insertInto('users').values({ id, email: p.email, name: p.name, oidc_issuer: p.issuer, oidc_subject: p.subject, avatar_url: p.avatarUrl, last_login_at: null, created_at: now, updated_at: now }).execute();
    return { ok: true, userId: id };
  }

  private async applyBootstrap(userId: string, email: string, verified: boolean): Promise<void> {
    const target = this.cfg.bootstrapAdminEmail?.toLowerCase();
    if (!target || !verified || email !== target) return;
    const has = await this.db.selectFrom('user_roles').select('source').where('user_id', '=', userId).where('role', '=', 'admin').executeTakeFirst();
    if (has) return;
    await this.db.insertInto('user_roles').values({ user_id: userId, role: 'admin', source: 'bootstrap', created_at: this.clock.now(), created_by: null }).execute();
    this.audit.auth({ userId, action: 'auth.bootstrap_admin' });
  }

  /** First start: if no admin exists and BOOTSTRAP_ADMIN_EMAIL is set, pre-create that user so the first login gets Admin. */
  async ensureBootstrapAdmin(): Promise<'created' | 'exists' | 'skipped'> {
    const email = this.cfg.bootstrapAdminEmail?.trim().toLowerCase();
    if (!email) return 'skipped';
    const admin = await this.db.selectFrom('user_roles').select('user_id').where('role', '=', 'admin').limit(1).executeTakeFirst();
    if (admin) return 'exists';
    const now = this.clock.now();
    let user = await this.db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst();
    if (!user) {
      user = { id: newId() };
      await this.db.insertInto('users').values({ id: user.id, email, name: email.split('@')[0]!, oidc_issuer: null, oidc_subject: null, avatar_url: null, last_login_at: null, created_at: now, updated_at: now }).execute();
    }
    await this.db.insertInto('user_roles').values({ user_id: user.id, role: 'admin', source: 'bootstrap', created_at: now, created_by: null }).onConflict((oc) => oc.columns(['user_id', 'role']).doNothing()).execute();
    this.audit.auth({ userId: user.id, action: 'auth.bootstrap_admin', reason: 'first_start' });
    return 'created';
  }

  async purgeExpiredStates(): Promise<void> {
    await this.db.deleteFrom('oidc_login_states').where('expires_at', '<=', this.clock.now()).execute();
  }
}
