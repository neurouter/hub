import { sql, type Kysely } from 'kysely';
import type { MainDB } from '../db/schema.js';
import type { Dialect } from '../db/url.js';

/** Query terms: lower-cased word tokens, at most 20. */
export function queryTerms(q: string): string[] {
  return (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 20);
}

/** FTS5 expression: quoted terms, implicit OR, prefix `*` on the last term (backend §11.4). */
export function fts5Query(q: string): string | null {
  const terms = queryTerms(q);
  if (!terms.length) return null;
  return terms.map((t, i) => `"${t}"${i === terms.length - 1 ? '*' : ''}`).join(' OR ');
}

/** to_tsquery expression with the same shape for Postgres. */
export function tsQuery(q: string): string | null {
  const terms = queryTerms(q);
  if (!terms.length) return null;
  return terms.map((t, i) => (i === terms.length - 1 ? `${t}:*` : t)).join(' | ');
}

export interface KeywordHit {
  toolId: string;
  /** Higher is better. */
  score: number;
}

/**
 * Keyword search over the tool catalog (backend §11): SQLite FTS5 bm25 with column weights
 * (exposed_name 10, title 5, description 2, params 1), Postgres ts_rank_cd over the generated
 * tsvector. The candidate set is ALWAYS restricted to `allowedIds` (ACL before ranking).
 */
export class KeywordIndex {
  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly dialect: Dialect,
  ) {}

  async search(q: string, allowedIds: readonly string[], limit = 50): Promise<KeywordHit[]> {
    if (!allowedIds.length) return [];
    if (this.dialect === 'sqlite') {
      const expr = fts5Query(q);
      if (!expr) return [];
      const r = await sql<{ id: string; rank: number }>`
        select t.id as id, bm25(tools_fts, 10.0, 5.0, 2.0, 1.0) as rank
        from tools_fts join tools t on t.seq = tools_fts.rowid
        where tools_fts match ${expr} and t.id in (${sql.join(allowedIds)})
        order by rank asc, t.exposed_name asc
        limit ${limit}`.execute(this.db);
      // bm25: lower is better (negative); flip so higher is better
      return r.rows.map((row) => ({ toolId: row.id, score: -Number(row.rank) }));
    }
    const expr = tsQuery(q);
    if (!expr) return [];
    const r = await sql<{ id: string; rank: number }>`
      select t.id as id, ts_rank_cd(t.search_tsv, to_tsquery('simple', ${expr})) as rank
      from tools t
      where t.id = any(${allowedIds}::uuid[]) and t.search_tsv @@ to_tsquery('simple', ${expr})
      order by rank desc, t.exposed_name asc
      limit ${limit}`.execute(this.db);
    return r.rows.map((row) => ({ toolId: row.id, score: Number(row.rank) }));
  }
}
