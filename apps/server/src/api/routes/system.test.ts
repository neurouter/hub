import { afterEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../test/fakes/context.js';
import { FakeEmbedder } from '../../test/fakes/fake-embedder.js';
import { seedCatalog } from '../../test/fakes/catalog-builders.js';

describe('system routes (search mode, reindex)', () => {
  let ctx: TestContext;
  afterEach(async () => ctx.close());

  it('keyword-only when embeddings are disabled: reindex → 409', async () => {
    ctx = await createTestContext();
    const admin = await ctx.user('admin@x.test', ['admin']);
    const user = await ctx.user('u@x.test');
    const forUser = (await ctx.as(user, { method: 'GET', url: '/api/system/info' })).json();
    expect(forUser).toMatchObject({ searchMode: 'keyword' });
    expect(forUser.searchIndex).toBeUndefined();
    expect((await ctx.as(admin, { method: 'GET', url: '/api/system/info' })).json()).toMatchObject({ searchMode: 'keyword', embeddingModel: null, embeddingReady: false });
    expect((await ctx.as(admin, { method: 'POST', url: '/api/system/reindex' })).statusCode).toBe(409);
    expect((await ctx.as(user, { method: 'POST', url: '/api/system/reindex' })).statusCode).toBe(403);
  });

  it('hybrid with a ready model: reindex runs as a job and is audited', async () => {
    const embedder = new FakeEmbedder({ modelId: 'test-model' });
    ctx = await createTestContext({ embedder });
    await seedCatalog(ctx.s.dbs.main.db, [{ slug: 's', tools: [{ name: 'a', description: 'Alpha tool' }, { name: 'b', description: 'Beta tool' }] }]);
    const admin = await ctx.user('admin@x.test', ['admin']);
    expect((await ctx.as(admin, { method: 'GET', url: '/api/system/info' })).json()).toMatchObject({ searchMode: 'hybrid', embeddingModel: 'test-model', embeddingReady: true });
    const r = await ctx.as(admin, { method: 'POST', url: '/api/system/reindex' });
    expect(r.statusCode).toBe(202);
    await ctx.s.jobs.idle();
    const job = (await ctx.as(admin, { method: 'GET', url: `/api/jobs/${r.json().jobId}` })).json();
    expect(job).toMatchObject({ kind: 'reindex', status: 'succeeded', result: { total: 2, embedded: 2, modelId: 'test-model' } });
    expect(await ctx.s.indexer.coverage()).toEqual({ tools: 2, embedded: 2 });
    expect((await ctx.as(admin, { method: 'GET', url: '/api/system/info' })).json().searchIndex).toEqual({ tools: 2, embedded: 2 });
  });
});
