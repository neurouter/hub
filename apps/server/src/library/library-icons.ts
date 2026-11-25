import type { Kysely } from 'kysely';
import type { MainDB } from '../db/schema.js';
import type { Clock } from '../lib/clock.js';
import { sha256Hex } from '../lib/crypto.js';
import { parseJsonColumn } from '../lib/json.js';
import type { FetchLike } from '../lib/net/safe-fetch.js';
import type { SettingsService } from '../settings/settings.service.js';
import { ICON_MAX_BYTES, pickServerInfoIcon, validateIcon, type CachedIcon } from '../catalog/icons.js';
import { githubNamespaceOwner, githubRepo } from '@neurouter/shared';

const DAY = 86_400_000;
const OK_TTL = 30 * DAY;
const MISS_TTL = 7 * DAY;
const FETCH_TIMEOUT_MS = 5000;
const HTML_MAX = 256 * 1024;

/** PNG embedded in an .ico (Vista+ icons store PNG frames); the largest one wins. BMP frames are skipped. */
export function pngFromIco(b: Buffer): Buffer | null {
  if (b.length < 6 || b.readUInt16LE(0) !== 0 || b.readUInt16LE(2) !== 1) return null;
  const count = b.readUInt16LE(4);
  let best: { size: number; data: Buffer } | null = null;
  for (let i = 0; i < count && 6 + (i + 1) * 16 <= b.length; i++) {
    const e = 6 + i * 16;
    const width = b[e] || 256;
    const len = b.readUInt32LE(e + 8);
    const off = b.readUInt32LE(e + 12);
    if (off + len > b.length || len < 8) continue;
    const data = b.subarray(off, off + len);
    if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && (!best || width > best.size)) best = { size: width, data };
  }
  return best ? Buffer.from(best.data) : null;
}

interface LinkIcon {
  href: string;
  rank: number;
}

/** `<link rel="icon|apple-touch-icon" href>` candidates in a page, best first (touch icons are 180 px PNGs). */
export function faviconLinks(html: string, base: string): string[] {
  const out: LinkIcon[] = [];
  for (const m of html.slice(0, HTML_MAX).matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const attr = (n: string) => new RegExp(`\\b${n}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)?.slice(1).find((x) => x !== undefined) ?? null;
    const rel = (attr('rel') ?? '').toLowerCase();
    const href = attr('href');
    if (!href || !/\b(icon|apple-touch-icon(-precomposed)?)\b/.test(rel)) continue;
    const type = (attr('type') ?? '').toLowerCase();
    let rank = 3;
    if (rel.includes('apple-touch-icon')) rank = 0;
    else if (type.includes('svg') || /\.svg(\?|$)/i.test(href)) rank = 1;
    else if (type.includes('png') || /\.png(\?|$)/i.test(href)) rank = 2;
    try {
      out.push({ href: new URL(href, base).toString(), rank });
    } catch {
      // ignore malformed hrefs
    }
  }
  return out.sort((a, b) => a.rank - b.rank).map((x) => x.href).filter((h) => h.startsWith('https://') || h.startsWith('data:image/'));
}

export interface IconEntry {
  id: string;
  server_json: unknown;
  website_url: string | null;
  repository_url: string | null;
  namespace: string;
}

/**
 * Library icons (same rules as server icons: never loaded by the browser from a third party).
 * Sources, first that validates: the registry entry's icon, the website's touch icon / favicon
 * (PNG frames are extracted from .ico), the GitHub owner's avatar. Fetched through the strict
 * outbound policy with a 5 s timeout and 256 KB cap, validated by magic bytes (SVGs screened),
 * cached 30 days (misses 7 days). Nothing is fetched while registry sync is off.
 */
export class LibraryIcons {
  private readonly inflight = new Map<string, Promise<CachedIcon | null>>();

  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly clock: Clock,
    private readonly fetch: FetchLike,
    private readonly settings: SettingsService,
  ) {}

  async get(entryId: string): Promise<CachedIcon | null> {
    const row = await this.db.selectFrom('library_icons').selectAll().where('entry_id', '=', entryId).executeTakeFirst();
    const cached = row?.bytes && row.content_type && row.etag ? { bytes: row.bytes, contentType: row.content_type, etag: row.etag } : null;
    const fresh = row && this.clock.now() - row.fetched_at < (cached ? OK_TTL : MISS_TTL);
    if (fresh || !(await this.settings.get('librarySync')).enabled) return cached;
    const entry = await this.db.selectFrom('library_entries').select(['id', 'server_json', 'website_url', 'repository_url', 'namespace']).where('id', '=', entryId).executeTakeFirst();
    if (!entry) return null;
    return (await this.refresh(entry)) ?? cached;
  }

  /** Fetches and stores the icon now (deduplicated per entry). */
  refresh(entry: IconEntry): Promise<CachedIcon | null> {
    let p = this.inflight.get(entry.id);
    if (!p) {
      p = this.load(entry).finally(() => this.inflight.delete(entry.id));
      this.inflight.set(entry.id, p);
    }
    return p;
  }

  private async load(entry: IconEntry): Promise<CachedIcon | null> {
    let lastError = 'No icon found';
    let found: { icon: CachedIcon; src: string } | null = null;
    for await (const src of this.candidates(entry)) {
      try {
        const bytes = await this.bytes(src);
        const v = validateIcon(bytes);
        if (!v.ok) throw new Error(v.error);
        found = { icon: { bytes, contentType: v.type, etag: sha256Hex(bytes).slice(0, 32) }, src };
        break;
      } catch (err) {
        lastError = `${src.slice(0, 200)}: ${(err as Error).message}`.slice(0, 300);
      }
    }
    const row = found
      ? { source_url: found.src.slice(0, 2048), content_type: found.icon.contentType, bytes: found.icon.bytes, etag: found.icon.etag, error: null, fetched_at: this.clock.now() }
      : { source_url: null, content_type: null, bytes: null, etag: null, error: lastError, fetched_at: this.clock.now() };
    await this.db
      .insertInto('library_icons')
      .values({ entry_id: entry.id, ...row })
      .onConflict((oc) => oc.column('entry_id').doUpdateSet(row))
      .execute();
    return found?.icon ?? null;
  }

  private async *candidates(entry: IconEntry): AsyncGenerator<string> {
    const json = parseJsonColumn<{ icons?: unknown }>(entry.server_json as never);
    const declared = pickServerInfoIcon(json?.icons);
    if (declared) yield declared;
    // a GitHub page as the "website" would give GitHub's own icon: the owner's avatar is the right one
    const site = entry.website_url?.startsWith('https://') && !/^https:\/\/(www\.)?github\.com(\/|$)/i.test(entry.website_url) ? entry.website_url : null;
    if (site) {
      let links: string[] = [];
      try {
        const res = await this.fetch(site, { headers: { accept: 'text/html' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (res.ok && (res.headers.get('content-type') ?? '').includes('html')) links = faviconLinks((await res.text()).slice(0, HTML_MAX), res.url || site);
        else await res.body?.cancel().catch(() => {});
      } catch {
        // the site may be down; fall through to /favicon.ico and the avatar
      }
      for (const l of links.slice(0, 3)) yield l;
      yield `${new URL(site).origin}/favicon.ico`;
    }
    const owner = githubRepo(entry.repository_url)?.owner ?? githubNamespaceOwner(entry.namespace);
    if (owner && /^[A-Za-z0-9-]{1,39}$/.test(owner)) yield `https://avatars.githubusercontent.com/${owner}?size=96`;
  }

  private async bytes(src: string): Promise<Buffer> {
    if (src.startsWith('data:')) {
      const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(src);
      if (!m) throw new Error('Malformed data: URL');
      return m[2] ? Buffer.from(m[3]!, 'base64') : Buffer.from(decodeURIComponent(m[3]!), 'utf8');
    }
    const res = await this.fetch(src, { headers: { accept: 'image/png,image/svg+xml,image/webp,image/jpeg,image/x-icon;q=0.8' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${res.status}`);
    }
    const len = Number(res.headers.get('content-length') ?? NaN);
    if (Number.isFinite(len) && len > ICON_MAX_BYTES * 4) {
      await res.body?.cancel().catch(() => {});
      throw new Error('Icon too large');
    }
    const b = Buffer.from(await res.arrayBuffer());
    return pngFromIco(b) ?? b;
  }
}
