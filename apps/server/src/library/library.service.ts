import { sql, type Kysely, type Selectable, type Updateable } from 'kysely';
import type {
  GradeFlag,
  LibraryCheck,
  LibraryEntryDetail,
  LibraryEntryRow,
  LibraryRemote,
  LibraryServerDraft,
  LibraryStatus,
  ListLibraryQuery,
  Page,
  QualityGrade,
  UpdateLibraryEntryBody,
  UpdateLibrarySettingsBody,
} from '@neurouter/shared';
import { computeGrade, githubRepo, lintDefinitions, summarizeParams, type ConnectionFacts, type DefinitionLint, type GithubFacts, type GradeRemote, type LintableTool, type RegistryFacts, type RuntimeFacts } from '@neurouter/shared';
import type { AuditRecorder } from '../audit/recorder.js';
import type { CoordinationStore } from '../coordination/types.js';
import type { LibraryEntriesTable, MainDB } from '../db/schema.js';
import type { Dialect } from '../db/url.js';
import { fts5Query, tsQuery } from '../search/keyword-index.js';
import type { Clock } from '../lib/clock.js';
import { toIso, toIsoOrNull } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { parseJsonColumn, toJsonColumn } from '../lib/json.js';
import type { FetchLike } from '../lib/net/safe-fetch.js';
import { assertUrlAllowed, SsrfError, type NetPolicy } from '../lib/net/ssrf-guard.js';
import { clampLimit, decodeCursor, encodeCursor } from '../lib/pagination.js';
import type { SecretProvider } from '../secrets/provider.js';
import type { SettingsService } from '../settings/settings.service.js';
import { connectUpstream } from '../upstream/client-factory.js';
import { classifyUpstreamError } from '../upstream/errors.js';
import { officialMeta, RegistryClient, type RegistryRecord } from './registry-client.js';
import { LibraryIcons } from './library-icons.js';

export const OFFICIAL_REGISTRY_URL = 'https://registry.modelcontextprotocol.io';
export const LIBRARY_ATTRIBUTION = 'Data from the Official MCP Registry (CC0). Listing does not imply endorsement by the registry or by Neurouter.';
const STATE_ID = 'registry';
const LEASE = 'library-sync';
const LEASE_MS = 30 * 60_000;
const OVERLAP_MS = 10 * 60_000;
const FULL_EVERY_MS = 7 * 86_400_000;
const MAX_PAGES = 5000;
const DAY = 86_400_000;

type EntryRow = Selectable<LibraryEntriesTable>;

/** Stored check: the API shape plus what the grader needs to recompute without a new check. */
interface StoredCheck extends LibraryCheck {
  lint: Omit<DefinitionLint, 'tools'> | null;
  githubOwner: string | null;
}

export interface LibraryDeps {
  db: Kysely<MainDB>;
  dialect: Dialect;
  clock: Clock;
  settings: SettingsService;
  secrets: SecretProvider;
  audit: AuditRecorder;
  coord: CoordinationStore;
  /** Registry and GitHub API requests (strict outbound policy, larger body cap). */
  fetch: FetchLike;
  /** Connection checks of library endpoints: strict outbound policy, never the upstream one. */
  probeFetch: FetchLike;
  probePolicy: NetPolicy;
  log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
  sleep?: (ms: number) => Promise<void>;
  version: string;
}

/* ------------------------------------------------------------------ normalization */

function normalizeRemotes(rec: RegistryRecord): LibraryRemote[] {
  const out: LibraryRemote[] = [];
  for (const r of rec.server.remotes ?? []) {
    if (!r || typeof r.url !== 'string' || (r.type !== 'streamable-http' && r.type !== 'sse')) continue;
    out.push({
      type: r.type,
      url: r.url.slice(0, 2000),
      headers: (Array.isArray(r.headers) ? r.headers : [])
        .filter((h) => h && typeof h.name === 'string')
        .slice(0, 20)
        .map((h) => ({ name: String(h.name).slice(0, 100), required: h.isRequired === true, secret: h.isSecret === true, description: typeof h.description === 'string' ? h.description.slice(0, 500) : null })),
      variables: [...new Set([...r.url.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!))].slice(0, 20),
    });
  }
  // prefer Streamable HTTP (SSE is deprecated)
  return out.sort((a, b) => (a.type === b.type ? 0 : a.type === 'streamable-http' ? -1 : 1));
}

function normalizePackages(rec: RegistryRecord) {
  return (rec.server.packages ?? [])
    .filter((p) => p && typeof p.identifier === 'string')
    .slice(0, 20)
    .map((p) => ({ registryType: String(p.registryType ?? 'unknown'), identifier: String(p.identifier).slice(0, 300), transport: String(p.transport?.type ?? 'stdio') }));
}

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/(^|-)mcp(-server)?$/g, '')
    .replace(/^-+|-+$/g, '');
  return (base || 'server').slice(0, 32).replace(/-+$/, '');
}

const ORDER = ['A', 'B', 'C', 'D', 'F'] as const;

/* ------------------------------------------------------------------ service */

export class LibraryService {
  readonly icons: LibraryIcons;

  constructor(private readonly d: LibraryDeps) {
    this.icons = new LibraryIcons(d.db, d.clock, d.fetch, d.settings);
  }

  private get db() {
    return this.d.db;
  }

  /* ---------------------------------------------------------------- settings + status */

  async status(): Promise<LibraryStatus> {
    const cfg = await this.d.settings.get('librarySync');
    const st = await this.state();
    const counts = await this.db
      .selectFrom('library_entries')
      .select((eb) => [
        eb.fn.countAll<number>().as('total'),
        eb.fn.sum<number>(sql`case when has_remote = 1 then 1 else 0 end`).as('remote'),
        eb.fn.sum<number>(sql`case when checked_at is not null then 1 else 0 end`).as('checked'),
      ])
      .where('status', '!=', 'deleted')
      .executeTakeFirstOrThrow();
    // a crashed replica leaves running=1; trust it only while the row is being touched
    const running = !!st?.running && this.d.clock.now() - st.updated_at < 10 * 60_000;
    return {
      enabled: cfg.enabled,
      registryUrl: cfg.registryUrl,
      autoCheck: cfg.autoCheck ?? true,
      hasGithubToken: cfg.githubTokenRef !== null,
      sync: {
        running,
        mode: st?.mode ?? null,
        pages: st?.pages ?? 0,
        lastRunAt: toIsoOrNull(st?.last_run_at ?? null),
        lastSuccessAt: toIsoOrNull(st?.last_success_at ?? null),
        lastFullAt: toIsoOrNull(st?.last_full_at ?? null),
        lastError: st?.last_error ?? null,
      },
      counts: { total: Number(counts.total ?? 0), remote: Number(counts.remote ?? 0), checked: Number(counts.checked ?? 0) },
      attribution: LIBRARY_ATTRIBUTION,
    };
  }

  async updateSettings(body: UpdateLibrarySettingsBody, actorId: string): Promise<LibraryStatus> {
    const cur = await this.d.settings.get('librarySync');
    const next = { ...cur };
    if (body.registryUrl !== undefined) {
      try {
        assertUrlAllowed(body.registryUrl, this.d.probePolicy);
      } catch (err) {
        if (err instanceof SsrfError) throw AppError.validation('Registry URL not allowed', [{ path: ['registryUrl'], message: err.message, code: 'url_not_allowed' }]);
        throw err;
      }
      next.registryUrl = body.registryUrl.replace(/\/+$/, '');
    }
    if (body.enabled !== undefined) next.enabled = body.enabled;
    if (body.autoCheck !== undefined) next.autoCheck = body.autoCheck;
    if (body.githubToken !== undefined) {
      if (body.githubToken === null) {
        if (cur.githubTokenRef) await this.d.secrets.delete({ id: cur.githubTokenRef }).catch(() => {});
        next.githubTokenRef = null;
      } else {
        next.githubTokenRef = (await this.d.secrets.put({ purpose: 'library_github_token', value: Buffer.from(body.githubToken), ...(cur.githubTokenRef ? { id: cur.githubTokenRef } : {}) })).id;
      }
    }
    await this.d.settings.set('librarySync', next, actorId);
    // a different registry is a different dataset: start over with a full crawl
    if (next.registryUrl !== cur.registryUrl) await this.db.deleteFrom('library_sync_state').where('id', '=', STATE_ID).execute();
    this.d.audit.admin({
      actorUserId: actorId,
      action: 'library.settings.update',
      targetType: 'settings',
      targetId: 'library',
      before: { enabled: cur.enabled, registryUrl: cur.registryUrl, autoCheck: cur.autoCheck ?? true, hasGithubToken: cur.githubTokenRef !== null },
      after: { enabled: next.enabled, registryUrl: next.registryUrl, autoCheck: next.autoCheck ?? true, hasGithubToken: next.githubTokenRef !== null },
    });
    return this.status();
  }

  private state() {
    return this.db.selectFrom('library_sync_state').selectAll().where('id', '=', STATE_ID).executeTakeFirst();
  }

  private async saveState(patch: Omit<Updateable<MainDB['library_sync_state']>, 'id'>): Promise<void> {
    const now = this.d.clock.now();
    await this.db
      .insertInto('library_sync_state')
      .values({ id: STATE_ID, ...patch, updated_at: now } as never)
      .onConflict((oc) => oc.column('id').doUpdateSet({ ...patch, updated_at: now } as never))
      .execute();
  }

  /* ---------------------------------------------------------------- sync */

  /** Starts a sync in the background (manual "Sync now"); false when disabled or already running. */
  async startSync(actorId: string): Promise<boolean> {
    const cfg = await this.d.settings.get('librarySync');
    if (!cfg.enabled) throw AppError.conflict('Registry sync is disabled. Enable it first.');
    const st = await this.state();
    if (st?.running && this.d.clock.now() - st.updated_at < 10 * 60_000) return false;
    this.d.audit.admin({ actorUserId: actorId, action: 'library.sync', targetType: 'settings', targetId: 'library' });
    void this.sync().catch((err: unknown) => this.d.log.warn({ err }, 'library sync failed'));
    return true;
  }

  /**
   * One sync run (hourly job and "Sync now"), exclusive across replicas through a lease.
   * First run, a resumed crawl, or a week since the last one: full crawl of latest versions (then
   * entries the registry no longer lists are marked deleted). Otherwise: incremental from the last
   * checkpoint minus an overlap; the checkpoint only advances after the last page.
   */
  async sync(): Promise<'ok' | 'disabled' | 'busy'> {
    const cfg = await this.d.settings.get('librarySync');
    if (!cfg.enabled) return 'disabled';
    const holder = newId();
    if (!(await this.d.coord.acquireLease(LEASE, holder, LEASE_MS))) return 'busy';
    const now = this.d.clock.now();
    const st = await this.state();
    const resume = st?.mode === 'full' && !!st.cursor;
    const full = resume || !st?.checkpoint || !st.last_full_at || now - st.last_full_at > FULL_EVERY_MS;
    const runStart = resume && st?.run_started_at ? st.run_started_at : now;
    let pages = resume ? (st?.pages ?? 0) : 0;
    let cursor: string | null = resume ? (st?.cursor ?? null) : null;
    await this.saveState({ running: 1, mode: full ? 'full' : 'incremental', pages, cursor, run_started_at: runStart, last_run_at: now, last_error: null });
    const client = new RegistryClient({ fetch: this.d.fetch, baseUrl: cfg.registryUrl, userAgent: `neurouter/${this.d.version} (library-sync)`, ...(this.d.sleep ? { sleep: this.d.sleep } : {}) });
    try {
      const since = full ? null : st!.checkpoint! - OVERLAP_MS;
      let upserts = 0;
      for (;;) {
        const page = await client.page({ cursor, updatedSince: since, latestOnly: full });
        upserts += await this.applyPage(page.servers, runStart);
        pages++;
        cursor = page.nextCursor;
        await this.saveState({ pages, cursor: full ? cursor : null });
        await this.d.coord.acquireLease(LEASE, holder, LEASE_MS); // renew
        if (!cursor) break;
        if (pages >= MAX_PAGES) throw new Error(`Stopped after ${MAX_PAGES} pages`);
      }
      let removed = 0;
      if (full) {
        const r = await this.db.updateTable('library_entries').set({ status: 'deleted', updated_at: this.d.clock.now() }).where('seen_at', '<', runStart).where('status', '!=', 'deleted').executeTakeFirst();
        removed = Number(r.numUpdatedRows);
      }
      const regraded = await this.regradeAll();
      const done = this.d.clock.now();
      await this.saveState({ running: 0, cursor: null, checkpoint: runStart, last_success_at: done, ...(full ? { last_full_at: done } : {}) });
      this.d.log.info({ mode: full ? 'full' : 'incremental', pages, upserts, removed, regraded }, 'library sync finished');
      return 'ok';
    } catch (err) {
      // keep the cursor: the next run resumes a full crawl where this one stopped
      await this.saveState({ running: 0, last_error: (err as Error).message.slice(0, 500) });
      throw err;
    } finally {
      await this.d.coord.releaseLease(LEASE, holder);
    }
  }

  /** Upserts the latest versions in one registry page; returns the number of rows written. */
  private async applyPage(records: RegistryRecord[], seenAt: number): Promise<number> {
    const now = this.d.clock.now();
    const rows: Array<Omit<EntryRow, 'hidden' | 'imported_server_id' | 'check_result' | 'checked_at' | 'grade' | 'grade_score' | 'confidence' | 'trust' | 'top_flag' | 'graded_at'>> = [];
    const deleted: string[] = [];
    for (const rec of records) {
      const meta = officialMeta(rec);
      if (!meta.isLatest) continue;
      const s = rec.server;
      const name = s.name.slice(0, 200);
      if (meta.status === 'deleted') {
        deleted.push(name);
        continue;
      }
      const remotes = normalizeRemotes(rec);
      const packages = normalizePackages(rec);
      if (!remotes.length && !packages.length) continue;
      const namespace = name.split('/')[0] ?? name;
      const repo = str(s.repository?.url, 500);
      const gh = githubRepo(repo);
      const hosts = remotes.map((r) => {
        try {
          return new URL(r.url).hostname;
        } catch {
          return '';
        }
      });
      rows.push({
        id: newId(),
        name,
        version: String(s.version).slice(0, 100),
        status: meta.status,
        status_message: meta.statusMessage?.slice(0, 500) ?? null,
        title: str(s.title, 200),
        description: str(s.description, 1000) ?? '',
        namespace,
        website_url: str(s.websiteUrl, 500),
        repository_url: repo,
        remotes: toJsonColumn(remotes),
        packages: toJsonColumn(packages),
        has_remote: remotes.length ? 1 : 0,
        has_packages: packages.length ? 1 : 0,
        has_icons: Array.isArray(s.icons) && s.icons.length ? 1 : 0,
        remote_url: remotes[0]?.url ?? null,
        transport: remotes[0] ? (remotes[0].type === 'sse' ? 'sse' : 'streamable_http') : null,
        server_json: toJsonColumn(s),
        published_at: meta.publishedAt,
        registry_updated_at: meta.updatedAt,
        seen_at: seenAt,
        search_text: [namespace.replace(/^io\.github\./, ''), gh ? `${gh.owner} ${gh.repo}` : '', ...hosts, ...packages.map((p) => p.identifier)].join(' ').slice(0, 2000),
        created_at: now,
        updated_at: now,
      });
    }
    // the same name can appear twice in an incremental window; the last one wins
    const byName = new Map(rows.map((r) => [r.name, r]));
    const unique = [...byName.values()];
    await this.db.transaction().execute(async (trx) => {
      for (const r of unique) {
        const { id: _id, created_at: _c, ...update } = r;
        await trx
          .insertInto('library_entries')
          .values(r as never)
          .onConflict((oc) => oc.column('name').doUpdateSet(update as never))
          .execute();
      }
      if (deleted.length) await trx.updateTable('library_entries').set({ status: 'deleted', updated_at: now }).where('name', 'in', deleted).execute();
      if (this.d.dialect === 'sqlite' && unique.length) {
        const ids = await trx.selectFrom('library_entries').select(['id', 'name', 'title', 'description', 'search_text']).where('name', 'in', unique.map((r) => r.name)).execute();
        await sql`delete from library_fts where entry_id in (${sql.join(ids.map((x) => x.id))})`.execute(trx);
        // `io.github.` prefixes more than half of all names: indexed, it makes "github" match everything
        for (const x of ids) await sql`insert into library_fts(entry_id, name, title, description, search_text) values (${x.id}, ${x.name.replace(/^io\.github\./, '')}, ${x.title ?? ''}, ${x.description}, ${x.search_text})`.execute(trx);
      }
    });
    return unique.length;
  }

  /* ---------------------------------------------------------------- grading */

  private registryFacts(r: Pick<EntryRow, 'name' | 'namespace' | 'status' | 'description' | 'title' | 'website_url' | 'repository_url' | 'remotes' | 'has_packages' | 'published_at'>, ctx: { namespaceCount: number; duplicateDescriptionCount: number; sharedUrlCount: number }): RegistryFacts {
    const remotes = (parseJsonColumn(r.remotes) as LibraryRemote[] | null) ?? [];
    return {
      name: r.name,
      namespace: r.namespace,
      status: r.status,
      description: r.description,
      title: r.title,
      websiteUrl: r.website_url,
      repositoryUrl: r.repository_url,
      remotes: remotes.map((x): GradeRemote => ({ type: x.type, url: x.url, headers: x.headers.map((h) => ({ name: h.name, required: h.required, description: h.description })) })),
      hasPackages: r.has_packages === 1,
      publishedAt: r.published_at,
      ...ctx,
    };
  }

  private checkFacts(stored: StoredCheck | null): { connection: ConnectionFacts | null; lint: DefinitionLint | null; github: GithubFacts | null } {
    if (!stored) return { connection: null, lint: null, github: null };
    const c = stored.connection;
    const connection: ConnectionFacts | null = c ? { ok: c.ok, authRequired: c.authRequired, oauthDiscovery: c.oauthDiscovery, paymentRequired: c.paymentRequired ?? false, protocolVersion: c.protocolVersion, latencyMs: c.latencyMs, toolCount: c.toolCount, error: c.error } : null;
    // tools are only known when the server listed them without credentials
    const lint: DefinitionLint | null = c?.ok && stored.lint ? { ...stored.lint, tools: stored.tools } : null;
    const g = stored.github;
    const github: GithubFacts | null = g && !g.error ? { found: g.found, archived: g.archived, stars: g.stars, pushedAt: g.pushedAt ? Date.parse(g.pushedAt) : null, license: g.license, ownerType: g.ownerType, ownerLogin: stored.githubOwner } : null;
    return { connection, lint, github };
  }

  private async contextFor(r: Pick<EntryRow, 'id' | 'namespace' | 'description' | 'remote_url'>) {
    const [ns, dup, url] = await Promise.all([
      this.db.selectFrom('library_entries').select((eb) => eb.fn.countAll<number>().as('n')).where('namespace', '=', r.namespace).where('status', '!=', 'deleted').executeTakeFirstOrThrow(),
      r.description.trim()
        ? this.db.selectFrom('library_entries').select(sql<number>`count(distinct namespace)`.as('n')).where('description', '=', r.description).where('status', '!=', 'deleted').executeTakeFirstOrThrow()
        : Promise.resolve({ n: 0 }),
      r.remote_url
        ? this.db.selectFrom('library_entries').select((eb) => eb.fn.countAll<number>().as('n')).where('remote_url', '=', r.remote_url).where('id', '!=', r.id).where('status', '!=', 'deleted').executeTakeFirstOrThrow()
        : Promise.resolve({ n: 0 }),
    ]);
    return { namespaceCount: Number(ns.n), duplicateDescriptionCount: Number(dup.n), sharedUrlCount: Number(url.n) };
  }

  private gradeRow(r: EntryRow, ctx: { namespaceCount: number; duplicateDescriptionCount: number; sharedUrlCount: number }): QualityGrade {
    const facts = this.checkFacts(parseJsonColumn(r.check_result) as StoredCheck | null);
    return computeGrade({ now: this.d.clock.now(), registry: this.registryFacts(r, ctx), ...facts });
  }

  private static gradeColumns(q: QualityGrade) {
    const top: GradeFlag | null = q.flags[0] ?? null;
    return { grade: q.grade, grade_score: q.score, confidence: q.confidence, trust: q.trust, top_flag: top ? toJsonColumn(top) : null };
  }

  /** Recomputes every grade after a sync (spam signals depend on the whole dataset); writes only changes. */
  async regradeAll(): Promise<number> {
    const rows = (await this.db.selectFrom('library_entries').selectAll().where('status', '!=', 'deleted').execute()) as EntryRow[];
    const nsCount = new Map<string, number>();
    const descNs = new Map<string, Set<string>>();
    const urlCount = new Map<string, number>();
    for (const r of rows) {
      nsCount.set(r.namespace, (nsCount.get(r.namespace) ?? 0) + 1);
      if (r.description.trim()) {
        let s = descNs.get(r.description);
        if (!s) descNs.set(r.description, (s = new Set()));
        s.add(r.namespace);
      }
      if (r.remote_url) urlCount.set(r.remote_url, (urlCount.get(r.remote_url) ?? 0) + 1);
    }
    const now = this.d.clock.now();
    const changes: Array<{ id: string; cols: ReturnType<typeof LibraryService.gradeColumns> }> = [];
    for (const r of rows) {
      const q = this.gradeRow(r, {
        namespaceCount: nsCount.get(r.namespace) ?? 1,
        duplicateDescriptionCount: r.description.trim() ? (descNs.get(r.description)?.size ?? 1) : 0,
        sharedUrlCount: r.remote_url ? (urlCount.get(r.remote_url) ?? 1) - 1 : 0,
      });
      const cols = LibraryService.gradeColumns(q);
      const prevTop = (parseJsonColumn(r.top_flag) as GradeFlag | null)?.code ?? null;
      const same = r.grade === cols.grade && Math.abs((r.grade_score ?? -1) - (cols.grade_score ?? -1)) < 1e-6 && r.confidence === cols.confidence && r.trust === cols.trust && prevTop === (q.flags[0]?.code ?? null) && r.graded_at !== null;
      if (!same) changes.push({ id: r.id, cols });
    }
    for (let i = 0; i < changes.length; i += 500) {
      const batch = changes.slice(i, i + 500);
      await this.db.transaction().execute(async (trx) => {
        for (const c of batch) await trx.updateTable('library_entries').set({ ...c.cols, graded_at: now }).where('id', '=', c.id).execute();
      });
    }
    return changes.length;
  }

  /* ---------------------------------------------------------------- read */

  async list(q: ListLibraryQuery): Promise<Page<LibraryEntryRow>> {
    const limit = clampLimit(q.limit, 30, 100);
    const offset = Number(decodeCursor(q.cursor)?.[0] ?? 0) || 0;
    const text = q.q?.trim() ?? '';
    const sort = q.sort ?? (text ? 'relevance' : 'grade');
    let base = this.db.selectFrom('library_entries as e').selectAll('e').where('e.status', '!=', 'deleted');
    if (q.remoteOnly !== false) base = base.where('e.has_remote', '=', 1);
    if (!q.includeHidden) base = base.where('e.hidden', '=', 0);
    if (q.minGrade) base = base.where('e.grade', 'in', ORDER.slice(0, ORDER.indexOf(q.minGrade) + 1) as unknown as Array<'A'>);
    if (q.trust === 'verified') base = base.where('e.trust', '=', 'verified');
    if (q.trust === 'known') base = base.where('e.trust', 'in', ['verified', 'known']);

    let rows: EntryRow[];
    if (text) {
      // keyword rank with a grade boost: a well-graded match outranks a slightly better text match
      if (this.d.dialect === 'sqlite') {
        const expr = fts5Query(text);
        if (!expr) return { items: [], nextCursor: null };
        let qb = base
          .innerJoin(sql<{ entry_id: string; rank: number }>`(select entry_id, bm25(library_fts, 10.0, 6.0, 2.0, 1.0) as rank from library_fts where library_fts match ${expr})`.as('f'), (j) => j.onRef('f.entry_id', '=', 'e.id'));
        qb = sort === 'relevance' ? qb.orderBy(sql`f.rank * (1 + 0.6 * coalesce(e.grade_score, 0.5))`) : qb;
        rows = (await this.ordered(qb, sort).limit(limit + 1).offset(offset).execute()) as EntryRow[];
      } else {
        const expr = tsQuery(text);
        if (!expr) return { items: [], nextCursor: null };
        // names match as typed ('simple'); descriptions are stemmed ('english'): query both forms
        const tsq = sql`(to_tsquery('simple', ${expr}) || to_tsquery('english', ${expr}))`;
        let qb = base.where(sql<boolean>`e.search_tsv @@ ${tsq}`);
        qb = sort === 'relevance' ? qb.orderBy(sql`ts_rank_cd(e.search_tsv, ${tsq}) * (1 + 0.6 * coalesce(e.grade_score, 0.5))`, 'desc') : qb;
        rows = (await this.ordered(qb, sort).limit(limit + 1).offset(offset).execute()) as EntryRow[];
      }
    } else {
      rows = (await this.ordered(base, sort).limit(limit + 1).offset(offset).execute()) as EntryRow[];
    }
    const hasMore = rows.length > limit;
    const slice = rows.slice(0, limit);
    const inGateway = await this.gatewayMatches(slice);
    return { items: slice.map((r) => this.toRow(r, inGateway.get(r.id) ?? null)), nextCursor: hasMore ? encodeCursor([offset + limit]) : null };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private ordered<Q extends { orderBy: (...a: any[]) => Q }>(qb: Q, sort: string): Q {
    if (sort === 'name') return qb.orderBy(sql`coalesce(e.title, e.name)`).orderBy('e.id');
    if (sort === 'updated') return qb.orderBy(sql`coalesce(e.registry_updated_at, e.updated_at)`, 'desc').orderBy('e.id');
    // letter first, then confidence, then score: a checked A outranks a preliminary (metadata-only) A
    if (sort === 'grade') return qb.orderBy(sql`coalesce(e.grade, 'Z')`).orderBy(sql`case e.confidence when 'high' then 0 when 'medium' then 1 else 2 end`).orderBy(sql`coalesce(e.grade_score, -1)`, 'desc').orderBy('e.name');
    return qb.orderBy('e.name');
  }

  /** Gateway servers that came from (or point at the same URL as) these entries. */
  private async gatewayMatches(rows: EntryRow[]): Promise<Map<string, { id: string; name: string }>> {
    const out = new Map<string, { id: string; name: string }>();
    if (!rows.length) return out;
    const ids = rows.map((r) => r.imported_server_id).filter((x): x is string => !!x);
    const urls = rows.map((r) => r.remote_url).filter((x): x is string => !!x);
    if (!ids.length && !urls.length) return out;
    const servers = await this.db
      .selectFrom('servers')
      .select(['id', 'name', 'url'])
      .where('status', '!=', 'disabled')
      .where((eb) => eb.or([...(ids.length ? [eb('id', 'in', ids)] : []), ...(urls.length ? [eb('url', 'in', urls)] : [])]))
      .execute();
    for (const r of rows) {
      const s = servers.find((x) => x.id === r.imported_server_id) ?? servers.find((x) => x.url === r.remote_url);
      if (s) out.set(r.id, { id: s.id, name: s.name });
    }
    return out;
  }

  private toRow(r: EntryRow, inGateway: { id: string; name: string } | null): LibraryEntryRow {
    return {
      id: r.id,
      name: r.name,
      title: r.title,
      description: r.description,
      version: r.version,
      status: r.status,
      namespace: r.namespace,
      hasRemote: r.has_remote === 1,
      hasPackages: r.has_packages === 1,
      transport: r.transport,
      repositoryUrl: r.repository_url,
      websiteUrl: r.website_url,
      grade: r.grade,
      confidence: r.confidence,
      trust: r.trust,
      topFlag: (parseJsonColumn(r.top_flag) as GradeFlag | null) ?? null,
      hidden: r.hidden === 1,
      inGateway,
      checkedAt: toIsoOrNull(r.checked_at),
      updatedAt: toIso(r.registry_updated_at ?? r.updated_at),
      iconUrl: `/api/library/${r.id}/icon`,
    };
  }

  private async load(id: string): Promise<EntryRow> {
    const r = (await this.db.selectFrom('library_entries').selectAll().where('id', '=', id).executeTakeFirst()) as EntryRow | undefined;
    if (!r) throw AppError.notFound('Library entry');
    return r;
  }

  async get(id: string): Promise<LibraryEntryDetail> {
    const r = await this.load(id);
    const quality = this.gradeRow(r, await this.contextFor(r));
    const inGateway = (await this.gatewayMatches([r])).get(r.id) ?? null;
    const stored = parseJsonColumn(r.check_result) as StoredCheck | null;
    const remotes = (parseJsonColumn(r.remotes) as LibraryRemote[] | null) ?? [];
    const cfg = await this.d.settings.get('librarySync');
    return {
      ...this.toRow({ ...r, ...LibraryService.gradeColumns(quality) } as EntryRow, inGateway),
      remotes,
      packages: (parseJsonColumn(r.packages) as LibraryEntryDetail['packages'] | null) ?? [],
      publishedAt: toIsoOrNull(r.published_at),
      statusMessage: r.status_message,
      quality,
      check: stored ? { checkedAt: stored.checkedAt, connection: stored.connection ? { ...stored.connection, paymentRequired: stored.connection.paymentRequired ?? false } : null, tools: stored.tools.map((t) => ({ ...t, title: t.title ?? null, description: t.description ?? '', params: t.params ?? [], annotations: t.annotations ?? {} })), github: stored.github } : null,
      draft: remotes.length ? await this.draft(r, remotes, stored) : null,
      serverJson: (parseJsonColumn(r.server_json) as Record<string, unknown>) ?? {},
      sourceUrl: `${cfg.registryUrl}/v0.1/servers/${encodeURIComponent(r.name)}/versions/latest`,
    };
  }

  /** "Add to gateway" pre-fill. Library imports always start untrusted and in strict pinning (set by the form). */
  private async draft(r: EntryRow, remotes: LibraryRemote[], check: StoredCheck | null): Promise<LibraryServerDraft> {
    const remote = remotes[0]!;
    const notes: string[] = [];
    const last = r.name.split('/').pop() ?? r.name;
    let slug = slugify(last);
    const taken = new Set((await this.db.selectFrom('servers').select('slug').where('slug', 'like', `${slug}%`).execute()).map((x) => x.slug));
    for (let n = 2; taken.has(slug); n++) slug = `${slugify(last).slice(0, 29)}-${n}`;
    if (remote.variables.length) notes.push(`Replace ${remote.variables.map((v) => `{${v}}`).join(', ')} in the URL.`);
    let auth: LibraryServerDraft['auth'] = { type: 'none' };
    const secretHeaders = remote.headers.filter((h) => h.secret || h.required);
    const headers = secretHeaders.length ? secretHeaders : remote.headers;
    if (headers.length) {
      const h = headers[0]!;
      auth = h.name.toLowerCase() === 'authorization' ? { type: 'shared_bearer' } : { type: 'shared_header', headerName: h.name };
      if (headers.length > 1) notes.push(`The server declares ${headers.length} headers (${headers.map((x) => x.name).join(', ')}); this gateway sends one. Only ${h.name} is pre-filled.`);
      if (h.description) notes.push(`${h.name}: ${h.description}`);
    } else if (check?.connection?.authRequired) {
      if (check.connection.oauthDiscovery) auth = { type: 'per_user_oauth' };
      else notes.push('The last check was rejected without credentials, and the entry declares no header. Ask the publisher how to authenticate.');
    }
    if (remote.type === 'sse') notes.push('This server only offers the deprecated SSE transport.');
    return { name: (r.title ?? last).slice(0, 100), slug, description: r.description, url: remote.url, transport: remote.type === 'sse' ? 'sse' : 'streamable_http', tags: ['library'], auth, notes };
  }

  async update(id: string, body: UpdateLibraryEntryBody, actorId: string): Promise<LibraryEntryDetail> {
    const r = await this.load(id);
    await this.db.updateTable('library_entries').set({ hidden: body.hidden ? 1 : 0 }).where('id', '=', id).execute();
    this.d.audit.admin({ actorUserId: actorId, action: body.hidden ? 'library.entry.hide' : 'library.entry.unhide', targetType: 'library_entry', targetId: id, before: { name: r.name, hidden: r.hidden === 1 } });
    return this.get(id);
  }

  /** Called after "Add to gateway" created a server from this entry. */
  async linkImported(entryId: string, serverId: string): Promise<void> {
    await this.db.updateTable('library_entries').set({ imported_server_id: serverId }).where('id', '=', entryId).execute();
  }

  /* ---------------------------------------------------------------- check */

  /**
   * On-demand check: connect WITHOUT credentials (strict outbound policy: library URLs come from
   * strangers, so private networks are refused), list and lint tools if allowed, look for OAuth
   * discovery, and look up the GitHub repository. Then regrade.
   */
  async check(id: string, actorId: string): Promise<LibraryEntryDetail> {
    await this.runCheck(await this.load(id), { actorId, github: true });
    return this.get(id);
  }

  /** One check; background checks read GitHub only with a token (60 unauthenticated lookups an hour would run out). */
  private async runCheck(r: EntryRow, opts: { actorId: string | null; github: boolean }): Promise<void> {
    const id = r.id;
    const cfg = await this.d.settings.get('librarySync');
    const remotes = (parseJsonColumn(r.remotes) as LibraryRemote[] | null) ?? [];
    const remote = remotes[0];
    const prev = parseJsonColumn(r.check_result) as StoredCheck | null;
    const readGithub = opts.github || cfg.githubTokenRef !== null;
    const [conn, fresh] = await Promise.all([remote ? this.probe(remote) : Promise.resolve(null), readGithub ? this.github(r.repository_url, cfg.githubTokenRef) : Promise.resolve(undefined)]);
    // keep the last GitHub result when this check didn't read it
    const github = fresh === undefined ? (prev?.github ? { api: prev.github, owner: prev.githubOwner ?? '' } : null) : fresh;
    const stored: StoredCheck = {
      checkedAt: new Date(this.d.clock.now()).toISOString(),
      connection: conn?.connection ?? null,
      tools: conn?.lint?.tools ?? [],
      github: github?.api ?? null,
      lint: conn?.lint ? { score: conn.lint.score, injection: conn.lint.injection, hiddenUnicode: conn.lint.hiddenUnicode, contradictions: conn.lint.contradictions, oversized: conn.lint.oversized } : null,
      githubOwner: github?.owner ?? null,
    };
    await this.icons.refresh(r).catch((err: unknown) => this.d.log.warn({ err, entry: r.name }, 'library icon refresh failed'));
    const updated = { ...r, check_result: toJsonColumn(stored), checked_at: this.d.clock.now() } as EntryRow;
    const q = this.gradeRow(updated, await this.contextFor(r));
    await this.db
      .updateTable('library_entries')
      .set({ check_result: updated.check_result, checked_at: updated.checked_at, ...LibraryService.gradeColumns(q), graded_at: this.d.clock.now() })
      .where('id', '=', id)
      .execute();
    if (opts.actorId) this.d.audit.admin({ actorUserId: opts.actorId, action: 'library.entry.check', targetType: 'library_entry', targetId: id, after: { name: r.name, grade: q.grade, connected: conn?.connection?.ok ?? null } });
  }

  /**
   * Background checks (every 10 minutes while sync and auto-check are on): a few entries per run,
   * most promising first — verified, then known publishers, then by grade — never checked or
   * checked over a week ago. Entries already capped at D/F by metadata are skipped (a check
   * can't lift a cap), as are hidden ones and URLs with template variables.
   */
  async checkBatch(limit = 20, concurrency = 4): Promise<number> {
    const cfg = await this.d.settings.get('librarySync');
    if (!cfg.enabled || cfg.autoCheck === false) return 0;
    const stale = this.d.clock.now() - 7 * DAY;
    const rows = (await this.db
      .selectFrom('library_entries')
      .selectAll()
      .where('status', '=', 'active')
      .where('has_remote', '=', 1)
      .where('hidden', '=', 0)
      .where('remote_url', 'not like', '%{%')
      .where((eb) => eb.or([eb('checked_at', 'is', null), eb('checked_at', '<', stale)]))
      .where((eb) => eb.or([eb('checked_at', 'is not', null), eb('grade', 'is', null), eb('grade', 'not in', ['D', 'F'])]))
      .orderBy(sql`case trust when 'verified' then 0 when 'known' then 1 else 2 end`)
      .orderBy(sql`case when checked_at is null then 0 else 1 end`)
      .orderBy(sql`coalesce(grade, 'Z')`)
      .orderBy(sql`coalesce(grade_score, -1)`, 'desc')
      .orderBy('name')
      .limit(limit)
      .execute()) as EntryRow[];
    let done = 0;
    const queue = [...rows];
    await Promise.all(
      Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        for (let r = queue.shift(); r; r = queue.shift()) {
          try {
            await this.runCheck(r, { actorId: null, github: false });
            done++;
          } catch (err) {
            this.d.log.warn({ err, entry: r.name }, 'library background check failed');
          }
        }
      }),
    );
    return done;
  }

  private async probe(remote: LibraryRemote): Promise<{ connection: LibraryCheck['connection']; lint: (Omit<DefinitionLint, 'tools'> & { tools: LibraryCheck['tools'] }) | null }> {
    const fail = (error: string, paymentRequired = false) => ({ connection: { ok: false, authRequired: false, oauthDiscovery: false, paymentRequired, protocolVersion: null, serverInfo: null, latencyMs: null, toolCount: null, error }, lint: null });
    if (remote.variables.length) return { connection: null, lint: null };
    try {
      assertUrlAllowed(remote.url, this.d.probePolicy);
    } catch (err) {
      return fail(`Not checked: ${(err as Error).message}`);
    }
    const start = performance.now();
    const signal = AbortSignal.timeout(10_000);
    let conn: Awaited<ReturnType<typeof connectUpstream>> | null = null;
    try {
      conn = await connectUpstream({ url: remote.url, transport: remote.type === 'sse' ? 'sse' : 'streamable_http', headers: {} }, this.d.probeFetch, { timeoutMs: 10_000, signal });
      const latencyMs = Math.round(performance.now() - start);
      const tools = ((await conn.client.listTools(undefined, { timeout: 10_000, signal })).tools as LintableTool[]).slice(0, 500);
      const lint = lintDefinitions(tools);
      // what the entry page shows: description, parameters and behaviour hints next to the lint result
      const shown: LibraryCheck['tools'] = lint.tools.map((l, i) => {
        const t = tools[i]!;
        const a = (t.annotations ?? {}) as Record<string, unknown>;
        const hint = (k: string) => (typeof a[k] === 'boolean' ? { [k]: a[k] as boolean } : {});
        return {
          ...l,
          name: String(t.name).slice(0, 128),
          title: typeof t.title === 'string' ? t.title.slice(0, 200) : typeof a.title === 'string' ? (a.title as string).slice(0, 200) : null,
          description: (t.description ?? '').slice(0, 4000),
          params: summarizeParams(t.inputSchema),
          annotations: { ...hint('readOnlyHint'), ...hint('destructiveHint'), ...hint('idempotentHint'), ...hint('openWorldHint') },
        };
      });
      return {
        connection: { ok: true, authRequired: false, oauthDiscovery: false, paymentRequired: false, protocolVersion: conn.protocolVersion, serverInfo: conn.serverInfo ? { name: conn.serverInfo.name.slice(0, 200), version: conn.serverInfo.version.slice(0, 100) } : null, latencyMs, toolCount: tools.length, error: null },
        lint: { ...lint, tools: shown },
      };
    } catch (err) {
      const e = classifyUpstreamError(err, signal);
      const latencyMs = Math.round(performance.now() - start);
      if (e.kind === 'auth_required') {
        return { connection: { ok: false, authRequired: true, oauthDiscovery: await this.oauthDiscovery(remote.url), paymentRequired: false, protocolVersion: null, serverInfo: null, latencyMs, toolCount: null, error: null }, lint: null };
      }
      // a paid endpoint (x402 and the like) is reachable, just not free
      const paid = e.details.status === 402 || /\b402\b/.test(e.message);
      return fail(e.message.slice(0, 300), paid);
    } finally {
      await conn?.client.close().catch(() => {});
    }
  }

  /** RFC 9728 protected-resource metadata (path-specific first, then the origin). */
  private async oauthDiscovery(url: string): Promise<boolean> {
    const u = new URL(url);
    const candidates = [`${u.origin}/.well-known/oauth-protected-resource${u.pathname === '/' ? '' : u.pathname}`, `${u.origin}/.well-known/oauth-protected-resource`];
    for (const c of [...new Set(candidates)]) {
      try {
        const res = await this.d.probeFetch(c, { headers: { accept: 'application/json' } });
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          continue;
        }
        const body = (await res.json()) as { authorization_servers?: unknown };
        if (Array.isArray(body.authorization_servers) && body.authorization_servers.length) return true;
      } catch {
        // try the next candidate
      }
    }
    return false;
  }

  private async github(repoUrl: string | null, tokenRef: string | null): Promise<{ api: NonNullable<LibraryCheck['github']>; owner: string } | null> {
    const gh = githubRepo(repoUrl);
    if (!gh) return null;
    const repo = `${gh.owner}/${gh.repo}`;
    const empty = { repo, found: false, archived: false, stars: 0, pushedAt: null, license: null, ownerType: null, error: null };
    try {
      const token = tokenRef ? (await this.d.secrets.get({ id: tokenRef })).toString('utf8') : null;
      const res = await this.d.fetch(`https://api.github.com/repos/${encodeURIComponent(gh.owner)}/${encodeURIComponent(gh.repo)}`, {
        headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': `neurouter/${this.d.version}`, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      });
      if (res.status === 404) return { api: empty, owner: gh.owner };
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return { api: { ...empty, error: `GitHub answered HTTP ${res.status}${res.status === 403 || res.status === 429 ? ' (rate limit; add a token in library settings)' : ''}` }, owner: gh.owner };
      }
      const b = (await res.json()) as { archived?: boolean; disabled?: boolean; stargazers_count?: number; pushed_at?: string; license?: { spdx_id?: string } | null; owner?: { type?: string; login?: string } };
      const ownerType = b.owner?.type === 'Organization' ? 'Organization' : b.owner?.type === 'User' ? 'User' : null;
      return {
        api: { repo, found: true, archived: !!b.archived || !!b.disabled, stars: Math.max(0, Math.trunc(Number(b.stargazers_count ?? 0))), pushedAt: b.pushed_at && Number.isFinite(Date.parse(b.pushed_at)) ? new Date(b.pushed_at).toISOString() : null, license: b.license?.spdx_id ?? null, ownerType, error: null },
        owner: b.owner?.login ?? gh.owner,
      };
    } catch (err) {
      return { api: { ...empty, error: (err as Error).message.slice(0, 200) }, owner: gh.owner };
    }
  }

  /* ---------------------------------------------------------------- servers in the gateway */

  /** Grade of a registered server: our own runtime evidence, its current definitions, and its library entry if imported. */
  async serverQuality(serverId: string): Promise<QualityGrade> {
    const now = this.d.clock.now();
    const server = await this.db.selectFrom('servers').select(['id', 'url', 'last_synced_at']).where('id', '=', serverId).executeTakeFirst();
    if (!server) throw AppError.notFound('Server');
    const [tools, checks, runs, rejected, usage, entry] = await Promise.all([
      this.db.selectFrom('tools').select(['upstream_name', 'title', 'description', 'input_schema', 'annotations', 'pending_definition', 'status']).where('server_id', '=', serverId).where('status', '!=', 'removed').execute(),
      this.db.selectFrom('server_health_checks').select(['ok', 'latency_ms']).where('server_id', '=', serverId).execute(),
      this.db.selectFrom('tool_sync_runs').select((eb) => eb.fn.sum<number>('changed').as('changed')).where('server_id', '=', serverId).where('started_at', '>=', now - 30 * DAY).executeTakeFirst(),
      this.db.selectFrom('tool_versions as v').innerJoin('tools as t', 't.id', 'v.tool_id').select((eb) => eb.fn.countAll<number>().as('n')).where('t.server_id', '=', serverId).where('v.decision', '=', 'rejected').executeTakeFirstOrThrow(),
      this.db
        .selectFrom('tool_usage_stats as u')
        .innerJoin('tools as t', 't.id', 'u.tool_id')
        .select((eb) => [sql<number>`count(distinct u.subject_type || ':' || u.subject_id)`.as('callers'), eb.fn.sum<number>('u.calls').as('calls')])
        .where('t.server_id', '=', serverId)
        .where('u.last_used_at', '>=', now - 30 * DAY)
        .executeTakeFirst(),
      this.db.selectFrom('library_entries').selectAll().where((eb) => eb.or([eb('imported_server_id', '=', serverId), eb('remote_url', '=', server.url)])).where('status', '!=', 'deleted').orderBy(sql`case when imported_server_id is null then 1 else 0 end`).executeTakeFirst(),
    ]);
    const defs: LintableTool[] = tools.map((t) => {
      const pending = parseJsonColumn(t.pending_definition) as LintableTool | null;
      return pending && t.status === 'changed'
        ? { ...pending, name: t.upstream_name }
        : { name: t.upstream_name, title: t.title, description: t.description, inputSchema: parseJsonColumn(t.input_schema), annotations: parseJsonColumn(t.annotations) as Record<string, unknown> | null };
    });
    const lat = checks.map((c) => c.latency_ms).filter((x): x is number => x !== null).sort((a, b) => a - b);
    const runtime: RuntimeFacts = {
      url: server.url,
      checks: checks.length,
      checksOk: checks.filter((c) => c.ok === 1).length,
      medianLatencyMs: lat.length ? lat[Math.floor(lat.length / 2)]! : null,
      definitionChanges30d: Number(runs?.changed ?? 0),
      rejectedVersions: Number(rejected.n),
      distinctCallers30d: Number(usage?.callers ?? 0),
      calls: Number(usage?.calls ?? 0),
    };
    const e = entry as EntryRow | undefined;
    const registry = e ? this.registryFacts(e, await this.contextFor(e)) : null;
    const github = e ? this.checkFacts(parseJsonColumn(e.check_result) as StoredCheck | null).github : null;
    return computeGrade({ now, registry, runtime, lint: defs.length || server.last_synced_at !== null ? lintDefinitions(defs) : null, github });
  }
}
