import type { Kysely } from 'kysely';
import type { MainDB } from '../db/schema.js';
import type { Clock } from '../lib/clock.js';
import { sha256Hex } from '../lib/crypto.js';
import { parseJsonColumn } from '../lib/json.js';
import type { FetchLike } from '../lib/net/safe-fetch.js';

export const ICON_MAX_BYTES = 256 * 1024;
export const SVG_MAX_BYTES = 64 * 1024;
export type IconType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml';

/** Content type from magic bytes; the header is advisory only (backend §14.5). */
export function sniffImage(b: Buffer): IconType | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  const head = b.subarray(0, 1024).toString('utf8').replace(/^\u{FEFF}/u, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return null;
}

/** Conservative SVG screen: no scripts, event handlers, foreignObject or external references. */
export function unsafeSvgReason(svg: string): string | null {
  if (Buffer.byteLength(svg) > SVG_MAX_BYTES) return 'SVG larger than 64 KB';
  if (/<script\b/i.test(svg)) return 'SVG contains a script';
  if (/\son[a-z]+\s*=/i.test(svg)) return 'SVG contains an event handler attribute';
  if (/<foreignObject\b/i.test(svg)) return 'SVG contains foreignObject';
  if (/(?:xlink:)?href\s*=\s*["']?\s*(?!#)[a-z][a-z0-9+.-]*:/i.test(svg)) return 'SVG references an external resource';
  if (/<!ENTITY/i.test(svg)) return 'SVG declares entities';
  return null;
}

export function validateIcon(bytes: Buffer): { ok: true; type: IconType } | { ok: false; error: string } {
  if (bytes.length === 0) return { ok: false, error: 'Empty icon' };
  if (bytes.length > ICON_MAX_BYTES) return { ok: false, error: 'Icon larger than 256 KB' };
  const type = sniffImage(bytes);
  if (!type) return { ok: false, error: 'Unsupported image type (PNG, JPEG, WebP or SVG only)' };
  if (type === 'image/svg+xml') {
    const reason = unsafeSvgReason(bytes.toString('utf8'));
    if (reason) return { ok: false, error: reason };
  }
  return { ok: true, type };
}

/** Prefer PNG around 64 px from `serverInfo.icons[]`; only https or data: sources (spec icon rules). */
export function pickServerInfoIcon(icons: unknown): string | null {
  if (!Array.isArray(icons)) return null;
  const candidates = icons
    .filter((i): i is { src: string; mimeType?: string; sizes?: string[] | string } => !!i && typeof i === 'object' && typeof (i as { src?: unknown }).src === 'string')
    .filter((i) => i.src.startsWith('https://') || i.src.startsWith('data:image/'));
  const size = (i: { sizes?: string[] | string }) => {
    const s = Array.isArray(i.sizes) ? i.sizes[0] : i.sizes;
    const m = /^(\d+)x\d+$/.exec(s ?? '');
    return m ? Math.abs(Number(m[1]) - 64) : 1000;
  };
  candidates.sort((a, b) => (a.mimeType === 'image/png' ? 0 : 1) - (b.mimeType === 'image/png' ? 0 : 1) || size(a) - size(b));
  return candidates[0]?.src ?? null;
}

export interface CachedIcon {
  bytes: Buffer;
  contentType: IconType;
  etag: string;
}

/**
 * Server icon proxy (backend §14.5): the frontend never loads remote images. Sources are fetched
 * through the strict outbound SSRF guard (no credentials, 5 s, 256 KB), validated by magic bytes
 * and cached in `server_icons` plus an in-process LRU.
 */
export class IconService {
  private readonly lru = new Map<string, CachedIcon | null>();

  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly clock: Clock,
    private readonly outboundFetch: FetchLike,
  ) {}

  private remember(id: string, v: CachedIcon | null): void {
    this.lru.delete(id);
    this.lru.set(id, v);
    if (this.lru.size > 100) this.lru.delete(this.lru.keys().next().value!);
  }

  async get(serverId: string): Promise<CachedIcon | null> {
    if (this.lru.has(serverId)) return this.lru.get(serverId) ?? null;
    const row = await this.db.selectFrom('server_icons').selectAll().where('server_id', '=', serverId).executeTakeFirst();
    const icon = row?.bytes && row.content_type && row.etag && !row.error ? { bytes: row.bytes, contentType: row.content_type, etag: row.etag } : null;
    this.remember(serverId, icon);
    return icon;
  }

  async sourceFor(serverId: string): Promise<string | null> {
    const s = await this.db.selectFrom('servers').select(['icon_url', 'server_info']).where('id', '=', serverId).executeTakeFirst();
    if (!s) return null;
    return s.icon_url ?? pickServerInfoIcon(parseJsonColumn<{ icons?: unknown }>(s.server_info)?.icons);
  }

  async fetchBytes(src: string): Promise<Buffer> {
    if (src.startsWith('data:')) {
      const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(src);
      if (!m) throw new Error('Malformed data: URL');
      return m[2] ? Buffer.from(m[3]!, 'base64') : Buffer.from(decodeURIComponent(m[3]!), 'utf8');
    }
    const res = await this.outboundFetch(src, { headers: { accept: 'image/png,image/jpeg,image/webp,image/svg+xml' }, credentials: 'omit' });
    if (res.status !== 200) throw new Error(`Icon fetch returned HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async refresh(serverId: string): Promise<{ ok: boolean; error: string | null }> {
    const src = await this.sourceFor(serverId);
    const now = this.clock.now();
    this.lru.delete(serverId);
    if (!src) {
      await this.db.deleteFrom('server_icons').where('server_id', '=', serverId).execute();
      return { ok: false, error: 'No icon source configured' };
    }
    let result: { ok: boolean; error: string | null };
    let values: { content_type: CachedIcon['contentType'] | null; bytes: Buffer | null; etag: string | null; error: string | null };
    try {
      const bytes = await this.fetchBytes(src);
      const v = validateIcon(bytes);
      if (!v.ok) throw new Error(v.error);
      values = { content_type: v.type, bytes, etag: sha256Hex(bytes).slice(0, 32), error: null };
      result = { ok: true, error: null };
    } catch (err) {
      const msg = (err as Error).message.slice(0, 300);
      values = { content_type: null, bytes: null, etag: null, error: msg };
      result = { ok: false, error: msg };
    }
    const row = { source_url: src.slice(0, 2048), fetched_at: now, ...values };
    await this.db
      .insertInto('server_icons')
      .values({ server_id: serverId, ...row })
      .onConflict((oc) => oc.column('server_id').doUpdateSet(row))
      .execute();
    return result;
  }
}

/**
 * Same-origin icon URL for API responses (null when there is no cached icon). The `v` query is
 * the content ETag, so a changed icon gets a new URL despite the proxy's `max-age` caching.
 */
export function iconPath(serverId: string, icon: { etag: string | null } | undefined): string | null {
  if (!icon) return null;
  const base = `/api/servers/${serverId}/icon`;
  return icon.etag ? `${base}?v=${encodeURIComponent(icon.etag.slice(0, 16))}` : base;
}
