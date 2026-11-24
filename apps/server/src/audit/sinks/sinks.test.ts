import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Databases } from '../../db/index.js';
import { newId } from '../../lib/ids.js';
import { createTestDatabases } from '../../test/fakes/test-db.js';
import { SqlAuditStore } from '../store.js';
import type { AuditRow } from '../types.js';
import { backoffMs, SINK_BACKOFF_MAX_MS, SinkDispatcher } from './dispatcher.js';
import { auditAttributes, OtelLogsSink, type LogProviderLike } from './otel-logs.js';
import type { AuditSink } from './sink.js';
import { signWebhook, verifyWebhookSignature, WebhookSink, webhookBody } from './webhook.js';

let dbs: Databases;
let now = Date.UTC(2026, 10, 24);
const clock = { now: () => now };
beforeEach(async () => {
  dbs = await createTestDatabases();
});
afterEach(async () => dbs.close());

async function seeded(n: number) {
  const store = new SqlAuditStore(dbs.audit.db, 'sqlite', { clock });
  for (let i = 0; i < n; i++) store.record({ id: newId(), ts: now + i, kind: 'tool_call', decision: 'allowed', status: 'ok', toolName: 'gh__x' });
  await store.flush();
  return store;
}

describe('webhook sink', () => {
  it('signs t=<ts>,v1=HMAC(secret, t.body) and the receiver check accepts it', () => {
    const sig = signWebhook('s3cret', 'body\n', 1_700_000_000_123);
    expect(sig).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature('s3cret', 'body\n', sig, 1_700_000_000_123)).toBe(true);
    expect(verifyWebhookSignature('other', 'body\n', sig, 1_700_000_000_123)).toBe(false);
    expect(verifyWebhookSignature('s3cret', 'body\n', sig, 1_700_000_999_000)).toBe(false); // stale
  });

  it('posts signed NDJSON (events + checkpoints) and throws on non-2xx', async () => {
    const store = await seeded(2);
    const batch = await store.readAfter(0, 10);
    const posts: { url: string; headers: Record<string, string>; body: string }[] = [];
    let status = 204;
    const sink = new WebhookSink({
      url: 'https://siem.test/hook',
      secret: async () => 'k',
      now: () => now,
      fetch: async (url, init) => {
        posts.push({ url: String(url), headers: init!.headers as Record<string, string>, body: String(init!.body) });
        return new Response(null, { status });
      },
    });
    await sink.deliver({ rows: batch.rows, checkpoints: [{ id: 'c', seq: 2, hash: 'h', kind: 'periodic', mac: 'm', keyId: 'k1', createdAt: now }] });
    const lines = posts[0]!.body.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(['event', 'event', 'checkpoint']);
    expect(verifyWebhookSignature('k', posts[0]!.body, posts[0]!.headers['x-neurouter-signature']!, now)).toBe(true);
    status = 500;
    await expect(sink.deliver({ rows: batch.rows, checkpoints: [] })).rejects.toMatchObject({ status: 500 });
    expect(webhookBody([], [])).toBe('');
  });
});

describe('sink dispatcher', () => {
  it('delivers in batches, advances the cursor only on success, and backs off on failure', async () => {
    const store = await seeded(7);
    const got: number[] = [];
    let fail = false;
    const sink: AuditSink = {
      name: 'test',
      deliver: async ({ rows }) => {
        if (fail) throw new Error('down');
        got.push(...rows.map((r: AuditRow) => r.seq));
      },
    };
    const d = new SinkDispatcher({ db: dbs.audit.db, store, sinks: async () => [sink], clock, log: { warn: () => {} }, batchSize: 3 });
    expect(await d.runOnce()).toEqual({ test: { delivered: 7, error: null } });
    expect(got).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(await d.cursor('test')).toBe(7);
    store.record({ id: newId(), ts: now, kind: 'system', decision: 'not_applicable', status: 'ok' });
    await store.flush();
    fail = true;
    expect((await d.runOnce()).test).toMatchObject({ delivered: 0, error: 'down' });
    expect(await d.cursor('test')).toBe(7);
    const cur = await dbs.audit.db.selectFrom('audit_sink_cursors').selectAll().executeTakeFirst();
    expect(cur?.last_error).toBe('down');
    fail = false;
    expect((await d.runOnce()).test).toMatchObject({ skipped: true }); // backing off
    now += backoffMs(1);
    expect((await d.runOnce()).test).toMatchObject({ delivered: 1, error: null });
    expect(got.at(-1)).toBe(8);
  });

  it('exponential backoff caps at one hour', () => {
    expect(backoffMs(1)).toBe(5000);
    expect(backoffMs(2)).toBe(10_000);
    expect(backoffMs(30)).toBe(SINK_BACKOFF_MAX_MS);
  });
});

describe('OTel logs sink', () => {
  it('emits one record per row with neurouter.audit.* attributes and flushes', async () => {
    const store = await seeded(2);
    const emitted: { body?: unknown; attributes?: Record<string, unknown> }[] = [];
    let flushed = 0;
    const provider: LogProviderLike = {
      getLogger: () => ({ emit: (r: { body?: unknown; attributes?: Record<string, unknown> }) => emitted.push(r), enabled: () => true }) as never,
      forceFlush: async () => void flushed++,
      shutdown: async () => {},
    };
    const sink = new OtelLogsSink(provider);
    await sink.deliver(await store.readAfter(0, 10));
    expect(emitted).toHaveLength(2);
    expect(emitted[0]!.attributes).toMatchObject({ 'event.name': 'neurouter.audit', 'neurouter.audit.seq': 1, 'neurouter.audit.tool_name': 'gh__x' });
    expect(flushed).toBe(1);
    expect(auditAttributes({ a: null, b: { c: 1 } })).toEqual({ 'neurouter.audit.b': '{"c":1}' });
  });
});
