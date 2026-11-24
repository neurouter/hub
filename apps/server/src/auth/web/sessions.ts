import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { MainDB } from '../../db/schema.js';
import type { Clock } from '../../lib/clock.js';
import { randomToken, sha256 } from '../../lib/crypto.js';

export interface SessionConfig {
  cookieName: string;
  secure: boolean;
  ttlMs: number;
  idleMs: number;
}

export interface WebSession {
  userId: string;
  csrfToken: string;
  expiresAt: number;
  idTokenHint: string | null;
  idHash: Buffer;
}

const SLIDE_EVERY_MS = 60_000;

/**
 * Web sessions (backend §7.1): 32-byte random cookie token, the DB stores sha256(token).
 * Absolute TTL plus a sliding idle TTL (`last_seen_at` refreshed at most once a minute).
 */
export class SessionService {
  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly clock: Clock,
    readonly cfg: SessionConfig,
  ) {}

  async create(userId: string, meta: { ip?: string | null; userAgent?: string | null; idTokenHint?: string | null } = {}): Promise<{ token: string; csrfToken: string; expiresAt: number }> {
    const token = randomToken(32);
    const csrfToken = randomToken(24);
    const now = this.clock.now();
    const expiresAt = now + this.cfg.ttlMs;
    await this.db
      .insertInto('web_sessions')
      .values({ id_hash: sha256(token), user_id: userId, csrf_token: csrfToken, created_at: now, expires_at: expiresAt, last_seen_at: now, ip: meta.ip ?? null, user_agent: meta.userAgent?.slice(0, 512) ?? null, id_token_hint: meta.idTokenHint ?? null })
      .execute();
    return { token, csrfToken, expiresAt };
  }

  async validate(token: string | undefined): Promise<WebSession | null> {
    if (!token || token.length < 20 || token.length > 100) return null;
    const idHash = sha256(token);
    const row = await this.db.selectFrom('web_sessions').selectAll().where('id_hash', '=', idHash).executeTakeFirst();
    if (!row) return null;
    const now = this.clock.now();
    if (row.expires_at <= now || row.last_seen_at + this.cfg.idleMs <= now) {
      await this.db.deleteFrom('web_sessions').where('id_hash', '=', idHash).execute();
      return null;
    }
    if (now - row.last_seen_at >= SLIDE_EVERY_MS) {
      await this.db.updateTable('web_sessions').set({ last_seen_at: now }).where('id_hash', '=', idHash).execute();
    }
    return { userId: row.user_id, csrfToken: row.csrf_token, expiresAt: row.expires_at, idTokenHint: row.id_token_hint, idHash };
  }

  async destroy(idHash: Buffer): Promise<void> {
    await this.db.deleteFrom('web_sessions').where('id_hash', '=', idHash).execute();
  }

  async purgeExpired(): Promise<number> {
    const now = this.clock.now();
    const res = await this.db
      .deleteFrom('web_sessions')
      .where((eb) => eb.or([eb('expires_at', '<=', now), eb('last_seen_at', '<=', now - this.cfg.idleMs)]))
      .executeTakeFirst();
    return Number(res.numDeletedRows ?? 0);
  }

  readCookie(req: FastifyRequest): string | undefined {
    return req.cookies?.[this.cfg.cookieName];
  }

  setCookie(reply: FastifyReply, token: string, expiresAt: number): void {
    reply.setCookie(this.cfg.cookieName, token, { path: '/', httpOnly: true, secure: this.cfg.secure, sameSite: 'lax', expires: new Date(expiresAt) });
  }

  clearCookie(reply: FastifyReply): void {
    reply.clearCookie(this.cfg.cookieName, { path: '/', httpOnly: true, secure: this.cfg.secure, sameSite: 'lax' });
  }
}
