import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { disabledEmbedder, EmbedderUnavailableError, WorkerEmbedder, type WorkerInbound, type WorkerLike, type WorkerOutbound } from './embedder.js';

/** Scripted stand-in for the worker thread: records messages, replies when told to. */
class FakeWorker extends EventEmitter implements WorkerLike {
  sent: WorkerInbound[] = [];
  terminated = false;
  postMessage(msg: WorkerInbound): void {
    this.sent.push(msg);
  }
  reply(msg: WorkerOutbound): void {
    this.emit('message', msg);
  }
  /** Answers the last embed with one-hot vectors. */
  answerLast(dims = 4): void {
    const m = this.sent.at(-1);
    if (m?.type !== 'embed') throw new Error('no pending embed');
    this.reply({ type: 'result', id: m.id, vectors: m.texts.map((_, i) => Float32Array.from({ length: dims }, (_, j) => (j === i % dims ? 1 : 0))) });
  }
  async terminate(): Promise<number> {
    this.terminated = true;
    return 0;
  }
}

function setup(opts: Partial<ConstructorParameters<typeof WorkerEmbedder>[0]> = {}) {
  const workers: FakeWorker[] = [];
  const e = new WorkerEmbedder({ model: 'onnx-community/granite-embedding-small-english-r2-ONNX', dtype: 'q8', dims: 4, modelsDir: '/models', allowRemote: false, createWorker: () => {
    const w = new FakeWorker();
    workers.push(w);
    return w;
  }, ...opts });
  return { e, workers };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('WorkerEmbedder', () => {
  afterEach(() => vi.useRealTimers());

  it('is lazy: nothing is spawned (and no model loaded) until warmUp()', async () => {
    const { e, workers } = setup();
    expect(e.status()).toBe('idle');
    await expect(e.embedQuery('hi')).rejects.toBeInstanceOf(EmbedderUnavailableError);
    expect(workers).toHaveLength(0);
    e.warmUp();
    e.warmUp();
    expect(workers).toHaveLength(1);
    expect(workers[0]!.sent[0]).toEqual({ type: 'init', model: 'onnx-community/granite-embedding-small-english-r2-ONNX', dtype: 'q8', modelsDir: '/models', allowRemote: false, pooling: 'cls' });
    expect(e.status()).toBe('loading');
    workers[0]!.reply({ type: 'ready', dims: 4 });
    expect(e.status()).toBe('ready');
    await e.close();
    expect(workers[0]!.terminated).toBe(true);
  });

  it('sends one message at a time and lets queries pre-empt queued index batches', async () => {
    const { e, workers } = setup();
    e.warmUp();
    const w = workers[0]!;
    w.reply({ type: 'ready', dims: 4 });
    const idx1 = e.embedDocuments(['d1', 'd2']);
    const idx2 = e.embedDocuments(['d3']);
    const q = e.embedQuery('find issues');
    expect(w.sent.filter((m) => m.type === 'embed')).toHaveLength(1); // only idx1 in flight
    w.answerLast();
    expect(await idx1).toHaveLength(2);
    // next out is the query, not idx2
    const next = w.sent.at(-1) as Extract<WorkerInbound, { type: 'embed' }>;
    expect(next.texts).toEqual(['find issues']);
    w.answerLast();
    expect(Array.from(await q)).toEqual([1, 0, 0, 0]);
    w.answerLast();
    expect(await idx2).toHaveLength(1);
  });

  it('caches query vectors (LRU) and applies the model query prefix', async () => {
    const { e, workers } = setup({ model: 'Xenova/bge-small-en-v1.5', queryCacheSize: 1 });
    e.warmUp();
    const w = workers[0]!;
    w.reply({ type: 'ready', dims: 4 });
    const p = e.embedQuery('a');
    const sent = w.sent.at(-1) as Extract<WorkerInbound, { type: 'embed' }>;
    expect(sent.texts[0]).toMatch(/^Represent this sentence for searching relevant passages: a$/);
    w.answerLast();
    await p;
    const before = w.sent.length;
    await e.embedQuery('a'); // cache hit
    expect(w.sent.length).toBe(before);
    const pb = e.embedQuery('b');
    w.answerLast();
    await pb;
    const pa = e.embedQuery('a'); // evicted by 'b' (size 1)
    expect(w.sent.length).toBe(before + 2);
    w.answerLast();
    await pa;
  });

  it('times out slow query embeddings (search falls back) and discards the late result', async () => {
    const { e, workers } = setup({ queryTimeoutMs: 20 });
    e.warmUp();
    const w = workers[0]!;
    w.reply({ type: 'ready', dims: 4 });
    await expect(e.embedQuery('slow')).rejects.toThrow(/timed out after 20 ms/);
    w.answerLast(); // late answer is ignored, the worker moves on
    const p = e.embedDocuments(['x']);
    w.answerLast();
    expect(await p).toHaveLength(1);
  });

  it('restarts the worker with backoff after a crash and rejects pending work', async () => {
    vi.useFakeTimers();
    const { e, workers } = setup({ backoffMs: [100, 1000] });
    e.warmUp();
    workers[0]!.reply({ type: 'ready', dims: 4 });
    const p = e.embedDocuments(['x']);
    workers[0]!.emit('exit', 1);
    await expect(p).rejects.toThrow(/exited with code 1/);
    expect(e.status()).toBe('error');
    await vi.advanceTimersByTimeAsync(99);
    expect(workers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(workers).toHaveLength(2);
    // a failed load backs off exponentially (200 ms for the second failure)
    workers[1]!.reply({ type: 'init_error', message: 'model not found and remote models are disabled' });
    expect(e.status()).toBe('error');
    await vi.advanceTimersByTimeAsync(199);
    expect(workers).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(workers).toHaveLength(3);
    workers[2]!.reply({ type: 'ready', dims: 4 });
    expect(e.status()).toBe('ready');
    // events from a dead worker are ignored
    workers[0]!.emit('exit', 1);
    expect(e.status()).toBe('ready');
    await e.close();
  });

  it('bounds the index queue and propagates worker errors', async () => {
    const { e, workers } = setup({ maxQueue: 1 });
    e.warmUp();
    const w = workers[0]!;
    w.reply({ type: 'ready', dims: 4 });
    const first = e.embedDocuments(['1']); // in flight
    const second = e.embedDocuments(['2']); // queued
    await expect(e.embedDocuments(['3'])).rejects.toThrow(/queue is full/);
    const m = w.sent.at(-1) as Extract<WorkerInbound, { type: 'embed' }>;
    w.reply({ type: 'error', id: m.id, message: 'boom' });
    await expect(first).rejects.toThrow('boom');
    await flush();
    w.answerLast();
    expect(await second).toHaveLength(1);
    await e.close();
  });

  it('disabled embedder: keyword-only', async () => {
    const d = disabledEmbedder('m', 384);
    expect(d.status()).toBe('disabled');
    d.warmUp();
    await expect(d.embedQuery('x')).rejects.toThrow(/disabled/);
    await expect(d.embedDocuments(['x'])).rejects.toThrow(/disabled/);
  });
});
