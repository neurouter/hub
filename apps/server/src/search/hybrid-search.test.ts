import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import type { MainDB } from '../db/schema.js';
import { MemoryCoordination } from '../coordination/memory.js';
import { SEARCH_EVAL_SET, seedCatalog, syntheticCatalog } from '../test/fakes/catalog-builders.js';
import { FakeEmbedder } from '../test/fakes/fake-embedder.js';
import { recordingKysely } from '../test/fakes/recording-dialect.js';
import { createTestDb } from '../test/fakes/test-db.js';
import { disabledEmbedder } from './embedder.js';
import { SearchIndexer } from './indexer.js';
import { KeywordIndex } from './keyword-index.js';
import { ToolSearchService } from './search.service.js';
import { createVectorIndex, fromBlob, PgVectorIndex, SqliteVectorIndex, toBlob } from './vector-index.js';

const log = { info: () => {}, warn: () => {}, debug: () => {} };
const clock = { now: () => Date.UTC(2026, 10, 24) };

describe('vector index', () => {
  it('round-trips float32 blobs', () => {
    const v = Float32Array.from([0.5, -1, 2]);
    expect(Array.from(fromBlob(toBlob(v)))).toEqual([0.5, -1, 2]);
  });

  it('sqlite-vec: exact cosine distance restricted to the allowed ids and the model', async () => {
    const t = await createTestDb();
    const seeded = await seedCatalog(t.db, [{ slug: 's', tools: [{ name: 'a', description: 'a' }, { name: 'b', description: 'b' }, { name: 'c', description: 'c' }] }]);
    const ids = [seeded.tools.s__a!, seeded.tools.s__b!, seeded.tools.s__c!];
    const idx = createVectorIndex(t.db, 'sqlite');
    expect(idx).toBeInstanceOf(SqliteVectorIndex);
    const vec = (...x: number[]) => Float32Array.from(x);
    await idx.upsert([
      { toolId: ids[0]!, toolSeq: 1, modelId: 'm', textHash: 'h1', vector: vec(1, 0, 0) },
      { toolId: ids[1]!, toolSeq: 2, modelId: 'm', textHash: 'h2', vector: vec(0.9, 0.1, 0) },
      { toolId: ids[2]!, toolSeq: 3, modelId: 'other', textHash: 'h3', vector: vec(1, 0, 0) },
    ], 1);
    const hits = await idx.search(vec(1, 0, 0), ids, 'm', 10);
    expect(hits.map((h) => h.toolId)).toEqual([ids[0], ids[1]]);
    expect(hits[0]!.distance).toBeCloseTo(0);
    // ACL: a disallowed id is never scanned
    expect((await idx.search(vec(1, 0, 0), [ids[1]!], 'm', 10)).map((h) => h.toolId)).toEqual([ids[1]]);
    expect(await idx.search(vec(1, 0, 0), [], 'm', 10)).toEqual([]);
    // upsert replaces in place
    await idx.upsert([{ toolId: ids[0]!, toolSeq: 1, modelId: 'm', textHash: 'h1b', vector: vec(0, 1, 0) }], 2);
    expect((await idx.hashes('m')).get(ids[0]!)).toBe('h1b');
    expect((await idx.search(vec(1, 0, 0), ids, 'm', 1))[0]!.toolId).toBe(ids[1]);
    await idx.clear();
    expect((await idx.hashes('m')).size).toBe(0);
    await t.close();
  });

  it('pgvector: <=> over tool_id = any(allowed), vectors bound as pgvector text', async () => {
    const { db, driver } = recordingKysely<MainDB>('postgres');
    const idx = new PgVectorIndex(db);
    await idx.search(Float32Array.from([1, 0]), ['01900000-0000-7000-8000-000000000001'], 'm', 50);
    const q = driver.queries[0]!;
    expect(q.sql).toMatch(/e\.embedding <=> \$1::vector as d[\s\S]*e\.model_id = \$2 and e\.tool_id = any\(\$3::uuid\[\]\)[\s\S]*order by d asc, e\.tool_id asc[\s\S]*limit \$4/);
    expect(q.parameters[0]).toBe('[1,0]');
    await idx.upsert([{ toolId: 't', toolSeq: 1, modelId: 'm', textHash: 'h', vector: Float32Array.from([0.25, 0.5]) }], 5);
    expect(driver.queries[1]!.sql).toMatch(/insert into "tool_embeddings"[\s\S]*on conflict \("tool_id"\) do update set/);
    expect(driver.queries[1]!.parameters).toContain('[0.25,0.5]');
  });
});

describe('hybrid tool search (320 tools, FakeEmbedder)', () => {
  let t: { db: Kysely<MainDB>; close: () => Promise<void> };
  let tools: Record<string, string>;
  let embedder: FakeEmbedder;
  let search: ToolSearchService;
  let indexer: SearchIndexer;
  let all: Set<string>;

  beforeEach(async () => {
    t = await createTestDb();
    ({ tools } = await seedCatalog(t.db, syntheticCatalog()));
    all = new Set(Object.values(tools));
    embedder = new FakeEmbedder({ synonyms: [['ticket', 'issue', 'bug'], ['message', 'post', 'chat'], ['remove', 'delete', 'drop'], ['show', 'list', 'enumerate'], ['vm', 'ec2', 'instance', 'server'], ['spreadsheet', 'sheet'], ['create', 'publish', 'schedule', 'open', 'new', 'start', 'log', 'share'], ['get', 'check', 'details', 'explain', 'invoke'], ['update', 'restart', 'updating'], ['revision', 'revisions']] });
    const vectors = createVectorIndex(t.db, 'sqlite');
    indexer = new SearchIndexer({ db: t.db, embedder, vectors, clock, coord: new MemoryCoordination(clock), log, batchSize: 16 });
    search = new ToolSearchService(t.db, new KeywordIndex(t.db, 'sqlite'), vectors, embedder, log);
  });
  afterEach(async () => {
    indexer.close();
    await t.close();
  });

  it('indexes in batches of 16, then only re-embeds what changed', async () => {
    const first = await indexer.run();
    expect(first).toMatchObject({ total: 320, embedded: 320, unchanged: 0, failed: 0, modelId: 'fake-embedder' });
    expect(embedder.calls.filter((c) => c.kind === 'index').every((c) => c.texts.length <= 16)).toBe(true);
    expect(embedder.calls.filter((c) => c.kind === 'index')).toHaveLength(20);
    expect(await indexer.run()).toMatchObject({ embedded: 0, unchanged: 320 });
    await t.db.updateTable('tools').set({ description: 'Open a brand-new GitHub issue' }).where('id', '=', tools.github__create_issue!).execute();
    expect(await indexer.run()).toMatchObject({ embedded: 1, unchanged: 319 });
    expect(await indexer.coverage()).toEqual({ tools: 320, embedded: 320 });
    const forced = await indexer.reindex();
    expect(forced.embedded).toBe(320);
  });

  it('a different model id re-embeds everything (EMBEDDINGS_MODEL change)', async () => {
    await indexer.run();
    const other = new FakeEmbedder({ modelId: 'other-model' });
    const idx2 = new SearchIndexer({ db: t.db, embedder: other, vectors: createVectorIndex(t.db, 'sqlite'), clock, coord: new MemoryCoordination(clock), log });
    expect(await idx2.run()).toMatchObject({ embedded: 320 });
  });

  it('fixed evaluation set: the right tool is in the top 3 for ≥ 80% of 30 queries', async () => {
    await indexer.run();
    const evalSet = SEARCH_EVAL_SET;
    expect(evalSet).toHaveLength(30);
    let hits = 0;
    const misses: string[] = [];
    for (const [q, expected] of evalSet) {
      const r = await search.search({ query: q, limit: 3, includeSchemas: false }, all);
      expect(r.mode).toBe('hybrid');
      if (r.tools.some((x) => x.name === expected)) hits++;
      else misses.push(`${q} → ${r.tools.map((x) => x.name).join(', ')}`);
    }
    expect(hits / evalSet.length, misses.join('\n')).toBeGreaterThanOrEqual(0.8);
  });

  it('ACL first: forbidden tools never appear, even as the best keyword and vector match', async () => {
    await indexer.run();
    const forbidden = new Set([tools.github__delete_repository!, tools.github__create_issue!, tools.jira__create_ticket!]);
    const allowed = new Set([...all].filter((id) => !forbidden.has(id)));
    for (const q of ['delete github repository', 'create issue', 'github__create_issue', 'create jira ticket', 'github']) {
      const r = await search.search({ query: q, limit: 25, includeSchemas: false }, allowed);
      const names = r.tools.map((x) => x.name);
      expect(names).not.toContain('github__delete_repository');
      expect(names).not.toContain('github__create_issue');
      expect(names).not.toContain('jira__create_ticket');
      expect(r.totalAllowed).toBe(317);
    }
    // only the allowed set is passed to the vector scan
    const empty = await search.search({ query: 'anything', limit: 5, includeSchemas: false }, new Set());
    expect(empty).toEqual({ tools: [], totalAllowed: 0, mode: 'hybrid' });
  });

  it('server filter, exact-name boost and schemas', async () => {
    await indexer.run();
    const r = await search.search({ query: 'list', limit: 5, includeSchemas: true, serverSlug: 'slack' }, all);
    expect(r.totalAllowed).toBe(40);
    expect(r.tools.every((x) => x.server === 'slack')).toBe(true);
    expect(r.tools[0]!.inputSchema).toMatchObject({ type: 'object' });
    const exact = await search.search({ query: 'create_message', limit: 1, includeSchemas: false }, all);
    expect(exact.tools[0]!.name).toBe('slack__create_message');
    expect(exact.tools[0]!.score).toBeGreaterThan(1);
  });

  it('degrades to keyword-only when the model is not ready or the query embedding fails', async () => {
    await indexer.run();
    embedder.state = 'loading';
    const r = await search.search({ query: 'create jira ticket', limit: 3, includeSchemas: false }, all);
    expect(r.mode).toBe('keyword');
    expect(search.mode()).toBe('keyword');
    expect(r.tools[0]!.name).toBe('jira__create_ticket');
    // a query with no keyword hit returns nothing in keyword mode
    expect((await search.search({ query: 'zzzz', limit: 3, includeSchemas: false }, all)).tools).toEqual([]);
    embedder.state = 'ready';
    embedder.embedQuery = async () => {
      throw new Error('timeout');
    };
    expect((await search.search({ query: 'create jira ticket', limit: 3, includeSchemas: false }, all)).mode).toBe('keyword');
    // indexer is a no-op while the model is unavailable
    const off = new SearchIndexer({ db: t.db, embedder: disabledEmbedder(), vectors: createVectorIndex(t.db, 'sqlite'), clock, coord: new MemoryCoordination(clock), log });
    expect(await off.run()).toBeNull();
    await expect(off.reindex()).rejects.toThrow(/disabled/);
    expect(new ToolSearchService(t.db, new KeywordIndex(t.db, 'sqlite')).mode()).toBe('keyword');
  });

  it('p95 latency on SQLite stays well under 50 ms at 320 tools', async () => {
    await indexer.run();
    const times: number[] = [];
    for (let i = 0; i < 40; i++) {
      const s = performance.now();
      await search.search({ query: `list items number ${i}`, limit: 8, includeSchemas: true }, all);
      times.push(performance.now() - s);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length * 0.95)]!).toBeLessThan(50);
  });
});
