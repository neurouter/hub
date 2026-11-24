import type { Kysely } from 'kysely';
import type { CoordinationStore } from '../coordination/types.js';
import type { MainDB } from '../db/schema.js';
import type { Clock } from '../lib/clock.js';
import { parseJsonColumn } from '../lib/json.js';
import { toolDocument, textHash } from './document.js';
import type { Embedder } from './embedder.js';
import type { VectorIndex } from './vector-index.js';

export const EMBED_BATCH_SIZE = 16;

export interface IndexRunResult {
  total: number;
  embedded: number;
  unchanged: number;
  failed: number;
  modelId: string;
}

interface Log {
  info: (o: object, m: string) => void;
  warn: (o: object, m: string) => void;
}

/**
 * Vector indexing (backend §11.1): builds each tool's search document, compares
 * `sha256(document + model_id)` with the stored `text_hash` and re-embeds what changed in
 * batches of 16. The keyword index (FTS5 / generated tsvector) is maintained by the tool write
 * path, so this only handles vectors. Runs under a cluster-wide lock so replicas don't duplicate
 * the work; `kick()` debounces triggers from tool sync / catalog changes.
 */
export class SearchIndexer {
  private kickTimer: NodeJS.Timeout | null = null;
  private running: Promise<IndexRunResult | null> | null = null;
  private closed = false;
  lastRun: (IndexRunResult & { at: number }) | null = null;

  constructor(
    private readonly d: {
      db: Kysely<MainDB>;
      embedder: Embedder;
      vectors: VectorIndex;
      clock: Clock;
      coord: CoordinationStore;
      log: Log;
      batchSize?: number;
      debounceMs?: number;
    },
  ) {}

  /** Schedules a run soon (debounced). No-op while the model isn't ready; the periodic job catches up. */
  kick(): void {
    if (this.closed || this.d.embedder.status() !== 'ready') return;
    if (this.kickTimer) clearTimeout(this.kickTimer);
    this.kickTimer = setTimeout(() => {
      this.kickTimer = null;
      void this.run().catch((err: unknown) => this.d.log.warn({ err }, 'search indexing failed'));
    }, this.d.debounceMs ?? 2000);
    this.kickTimer.unref?.();
  }

  /** One pass over the catalog. Returns null when skipped (model not ready or another run active). */
  async run(opts: { force?: boolean; progress?: (p: number) => Promise<void> } = {}): Promise<IndexRunResult | null> {
    if (this.d.embedder.status() !== 'ready') return null;
    if (this.running) return opts.force ? this.running.then(() => this.run(opts)) : this.running;
    this.running = this.d.coord.withLock('search-index', 10 * 60_000, () => this.pass(opts)).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async pass(opts: { force?: boolean; progress?: (p: number) => Promise<void> }): Promise<IndexRunResult> {
    const { embedder, vectors } = this.d;
    const modelId = embedder.modelId;
    const tools = await this.d.db.selectFrom('tools').select(['id', 'seq', 'exposed_name', 'title', 'description', 'input_schema']).where('status', '!=', 'removed').orderBy('seq').execute();
    const stored = opts.force ? new Map<string, string>() : await vectors.hashes(modelId);
    const todo: Array<{ id: string; seq: number; doc: string; hash: string }> = [];
    for (const t of tools) {
      const doc = toolDocument({ exposedName: t.exposed_name, title: t.title, description: t.description, inputSchema: parseJsonColumn(t.input_schema) });
      const hash = textHash(doc, modelId);
      if (stored.get(t.id) !== hash) todo.push({ id: t.id, seq: Number(t.seq), doc, hash });
    }
    const size = this.d.batchSize ?? EMBED_BATCH_SIZE;
    let embedded = 0;
    let failed = 0;
    for (let i = 0; i < todo.length && !this.closed; i += size) {
      const batch = todo.slice(i, i + size);
      try {
        const vecs = await embedder.embedDocuments(batch.map((b) => b.doc));
        await vectors.upsert(
          batch.map((b, j) => ({ toolId: b.id, toolSeq: b.seq, modelId, textHash: b.hash, vector: vecs[j]! })),
          this.d.clock.now(),
        );
        embedded += batch.length;
      } catch (err) {
        failed += batch.length;
        this.d.log.warn({ err, batch: batch.length }, 'embedding batch failed');
        if (embedder.status() !== 'ready') {
          failed += todo.length - i - batch.length;
          break;
        }
      }
      await opts.progress?.(Math.min(1, (i + batch.length) / todo.length));
    }
    const result: IndexRunResult = { total: tools.length, embedded, unchanged: tools.length - todo.length, failed, modelId };
    this.lastRun = { ...result, at: this.d.clock.now() };
    if (embedded || failed) this.d.log.info(result, 'search index updated');
    return result;
  }

  /** Re-embeds every tool (admin reindex job, or after an EMBEDDINGS_MODEL change). */
  async reindex(progress?: (p: number) => Promise<void>): Promise<IndexRunResult> {
    if (this.d.embedder.status() === 'disabled') throw new Error('Embeddings are disabled (EMBEDDINGS_ENABLED=false); search is keyword-only');
    if (this.d.embedder.status() !== 'ready') throw new Error(`The embedding model is not ready (${this.d.embedder.status()}); retry when it has loaded`);
    const out = await this.run({ force: true, ...(progress ? { progress } : {}) });
    if (!out) throw new Error('The embedding model is not ready');
    return out;
  }

  /** Counts for /api/system/info and readiness of hybrid search. */
  async coverage(): Promise<{ tools: number; embedded: number }> {
    const [t, e] = await Promise.all([
      this.d.db.selectFrom('tools').select((eb) => eb.fn.countAll<number>().as('n')).where('status', '!=', 'removed').executeTakeFirst(),
      this.d.db.selectFrom('tool_embeddings').select((eb) => eb.fn.countAll<number>().as('n')).where('model_id', '=', this.d.embedder.modelId).executeTakeFirst(),
    ]);
    return { tools: Number(t?.n ?? 0), embedded: Number(e?.n ?? 0) };
  }

  close(): void {
    this.closed = true;
    if (this.kickTimer) clearTimeout(this.kickTimer);
  }
}
