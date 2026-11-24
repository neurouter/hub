import { sql, type Kysely } from 'kysely';
import { toSql } from 'pgvector';
import type { MainDB } from '../db/schema.js';
import type { Dialect } from '../db/url.js';

export interface VectorRow {
  toolId: string;
  toolSeq: number;
  modelId: string;
  textHash: string;
  vector: Float32Array;
}

export interface VectorHit {
  toolId: string;
  /** Cosine distance (0 = identical). */
  distance: number;
}

/**
 * Exact cosine-distance search over the ACL-allowed tool set (backend §0.2.3 / §11.4 step 3):
 * sqlite-vec `vec_distance_cosine` over float32 BLOBs, pgvector `<=>` on Postgres. ANN indexes
 * can't take an arbitrary allow-list efficiently, so the scan is exact and deterministic.
 */
export interface VectorIndex {
  upsert(rows: readonly VectorRow[], now: number): Promise<void>;
  search(query: Float32Array, allowedIds: readonly string[], modelId: string, limit: number): Promise<VectorHit[]>;
  /** Existing (tool id → text hash) for one model. */
  hashes(modelId: string): Promise<Map<string, string>>;
  clear(): Promise<void>;
}

export const toBlob = (v: Float32Array): Buffer => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
export const fromBlob = (b: Uint8Array): Float32Array => new Float32Array(new Uint8Array(b).buffer);

export function createVectorIndex(db: Kysely<MainDB>, dialect: Dialect): VectorIndex {
  return dialect === 'postgres' ? new PgVectorIndex(db) : new SqliteVectorIndex(db);
}

abstract class BaseVectorIndex implements VectorIndex {
  constructor(protected readonly db: Kysely<MainDB>) {}
  protected abstract encode(v: Float32Array): Buffer | string;

  async upsert(rows: readonly VectorRow[], now: number): Promise<void> {
    if (!rows.length) return;
    const values = rows.map((r) => ({ tool_id: r.toolId, tool_seq: r.toolSeq, model_id: r.modelId, dims: r.vector.length, text_hash: r.textHash, embedding: this.encode(r.vector), updated_at: now }));
    await this.db
      .insertInto('tool_embeddings')
      .values(values)
      .onConflict((oc) =>
        oc.column('tool_id').doUpdateSet((eb) => ({
          tool_seq: eb.ref('excluded.tool_seq'),
          model_id: eb.ref('excluded.model_id'),
          dims: eb.ref('excluded.dims'),
          text_hash: eb.ref('excluded.text_hash'),
          embedding: eb.ref('excluded.embedding'),
          updated_at: eb.ref('excluded.updated_at'),
        })),
      )
      .execute();
  }

  async hashes(modelId: string): Promise<Map<string, string>> {
    const rows = await this.db.selectFrom('tool_embeddings').select(['tool_id', 'text_hash']).where('model_id', '=', modelId).execute();
    return new Map(rows.map((r) => [r.tool_id, r.text_hash]));
  }

  async clear(): Promise<void> {
    await this.db.deleteFrom('tool_embeddings').execute();
  }

  abstract search(query: Float32Array, allowedIds: readonly string[], modelId: string, limit: number): Promise<VectorHit[]>;
}

export class SqliteVectorIndex extends BaseVectorIndex {
  protected encode(v: Float32Array): Buffer {
    return toBlob(v);
  }

  async search(query: Float32Array, allowedIds: readonly string[], modelId: string, limit: number): Promise<VectorHit[]> {
    if (!allowedIds.length) return [];
    // one JSON parameter instead of thousands of bound ids
    const r = await sql<{ tool_id: string; d: number }>`
      select e.tool_id as tool_id, vec_distance_cosine(e.embedding, ${toBlob(query)}) as d
      from tool_embeddings e
      where e.model_id = ${modelId} and e.dims = ${query.length}
        and e.tool_id in (select value from json_each(${JSON.stringify(allowedIds)}))
      order by d asc, e.tool_id asc
      limit ${limit}`.execute(this.db);
    return r.rows.map((row) => ({ toolId: row.tool_id, distance: Number(row.d) }));
  }
}

export class PgVectorIndex extends BaseVectorIndex {
  protected encode(v: Float32Array): string {
    return toSql(Array.from(v))!;
  }

  async search(query: Float32Array, allowedIds: readonly string[], modelId: string, limit: number): Promise<VectorHit[]> {
    if (!allowedIds.length) return [];
    const r = await sql<{ tool_id: string; d: number }>`
      select e.tool_id as tool_id, e.embedding <=> ${this.encode(query)}::vector as d
      from tool_embeddings e
      where e.model_id = ${modelId} and e.tool_id = any(${allowedIds}::uuid[])
      order by d asc, e.tool_id asc
      limit ${limit}`.execute(this.db);
    return r.rows.map((row) => ({ toolId: row.tool_id, distance: Number(row.d) }));
  }
}
