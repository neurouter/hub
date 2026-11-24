import type { Kysely } from 'kysely';
import type { SearchToolsResultItem } from '@neurouter/shared';
import type { MainDB } from '../db/schema.js';
import { parseJsonColumn, toBool } from '../lib/json.js';
import type { Embedder } from './embedder.js';
import { fuseRankings } from './hybrid.js';
import type { KeywordIndex } from './keyword-index.js';
import type { VectorIndex } from './vector-index.js';

export interface ToolSearchInput {
  query: string;
  limit: number;
  serverSlug?: string;
  includeSchemas: boolean;
}

/** Candidates taken from each ranked list before fusion (backend §11.4). */
export const LIST_DEPTH = 50;

export type SearchMode = 'hybrid' | 'keyword';

/**
 * `search_tools` / catalog search (backend §11.4):
 * 1. the ACL-allowed set (∩ server filter) is computed first: nothing else is ever scored;
 * 2. keyword list: top 50 by BM25 / ts_rank among allowed;
 * 3. vector list: top 50 by exact cosine distance among allowed (skipped when the model isn't
 *    ready or the query embedding takes longer than 2 s; the request is then keyword-only);
 * 4. RRF (k = 60) + exact-name boost, ties by exposed name.
 */
export class ToolSearchService {
  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly keyword: KeywordIndex,
    private readonly vectors: VectorIndex | null = null,
    private readonly embedder: Embedder | null = null,
    private readonly log?: { debug: (o: object, m: string) => void },
  ) {}

  /** 'hybrid' when the embedding model is loaded, otherwise 'keyword'. */
  mode(): SearchMode {
    return this.vectors && this.embedder?.status() === 'ready' ? 'hybrid' : 'keyword';
  }

  private async vectorList(query: string, ids: readonly string[]): Promise<string[]> {
    if (!this.vectors || !this.embedder || this.embedder.status() !== 'ready') return [];
    try {
      const q = await this.embedder.embedQuery(query);
      return (await this.vectors.search(q, ids, this.embedder.modelId, LIST_DEPTH)).map((h) => h.toolId);
    } catch (err) {
      this.log?.debug({ err }, 'vector search skipped; keyword-only for this request');
      return [];
    }
  }

  async search(input: ToolSearchInput, allowed: ReadonlySet<string>): Promise<{ tools: SearchToolsResultItem[]; totalAllowed: number; mode: SearchMode }> {
    let ids = [...allowed];
    if (input.serverSlug && ids.length) {
      const rows = await this.db.selectFrom('tools as t').innerJoin('servers as s', 's.id', 't.server_id').select('t.id').where('s.slug', '=', input.serverSlug).where('t.id', 'in', ids).execute();
      ids = rows.map((r) => r.id);
    }
    if (!ids.length) return { tools: [], totalAllowed: 0, mode: this.mode() };
    const q = input.query.trim().toLowerCase();
    const [kw, vec, exact] = await Promise.all([
      this.keyword.search(input.query, ids, LIST_DEPTH),
      this.vectorList(input.query, ids),
      this.db
        .selectFrom('tools')
        .select('id')
        .where('id', 'in', ids)
        .where((eb) => eb.or([eb.fn('lower', ['exposed_name']), eb.fn('lower', ['upstream_name'])].map((e) => eb(e, '=', q))))
        .execute(),
    ]);
    const mode: SearchMode = vec.length ? 'hybrid' : 'keyword';
    const candidates = new Set([...kw.map((h) => h.toolId), ...vec, ...exact.map((e) => e.id)]);
    if (!candidates.size) return { tools: [], totalAllowed: ids.length, mode };
    const rows = await this.db
      .selectFrom('tools as t')
      .innerJoin('servers as s', 's.id', 't.server_id')
      .select(['t.id', 't.exposed_name', 't.title', 't.description', 't.input_schema', 't.requires_approval', 's.slug'])
      .where('t.id', 'in', [...candidates])
      .execute();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ranked = fuseRankings({
      lists: [kw.map((h) => h.toolId), vec],
      allowed: new Set(ids),
      names: new Map(rows.map((r) => [r.id, r.exposed_name])),
      exact: new Set(exact.map((e) => e.id)),
      limit: input.limit,
    });
    return {
      totalAllowed: ids.length,
      mode,
      tools: ranked.flatMap((c) => {
        const r = byId.get(c.id);
        if (!r) return [];
        return [
          {
            name: r.exposed_name,
            ...(r.title ? { title: r.title } : {}),
            description: r.description,
            server: r.slug,
            ...(input.includeSchemas ? { inputSchema: parseJsonColumn<Record<string, unknown>>(r.input_schema) ?? { type: 'object' } } : {}),
            requiresApproval: toBool(r.requires_approval),
            score: Math.round(c.score * 1e6) / 1e6,
          },
        ];
      }),
    };
  }
}
