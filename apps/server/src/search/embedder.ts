import { Worker } from 'node:worker_threads';
import { modelProfile, type ModelProfile } from './model-profiles.js';

export type EmbedKind = 'query' | 'index';
export type EmbedderStatus = 'disabled' | 'idle' | 'loading' | 'ready' | 'error';

export type WorkerInbound =
  | { type: 'init'; model: string; dtype: string; modelsDir: string; allowRemote: boolean; pooling: 'cls' | 'mean' }
  | { type: 'embed'; id: number; texts: string[] };

export type WorkerOutbound =
  | { type: 'ready'; dims: number }
  | { type: 'init_error'; message: string }
  | { type: 'result'; id: number; vectors: Float32Array[] }
  | { type: 'error'; id: number; message: string };

/** Local embedding model behind a small interface (backend §11.3); tests use `FakeEmbedder`. */
export interface Embedder {
  readonly modelId: string;
  readonly dims: number;
  status(): EmbedderStatus;
  /** Starts loading the model in the background (no-op when disabled or already started). */
  warmUp(): void;
  /** Query vector; rejects fast when not ready or after `timeoutMs` (search then falls back to keyword). */
  embedQuery(text: string, timeoutMs?: number): Promise<Float32Array>;
  /** Document vectors (index path, lower priority than queries). */
  embedDocuments(texts: readonly string[]): Promise<Float32Array[]>;
  close(): Promise<void>;
}

export class EmbedderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbedderUnavailableError';
  }
}

/** Embeddings switched off (`EMBEDDINGS_ENABLED=false`): search is keyword-only. */
export function disabledEmbedder(modelId = 'disabled', dims = 384): Embedder {
  return {
    modelId,
    dims,
    status: () => 'disabled',
    warmUp: () => {},
    embedQuery: () => Promise.reject(new EmbedderUnavailableError('embeddings are disabled')),
    embedDocuments: () => Promise.reject(new EmbedderUnavailableError('embeddings are disabled')),
    close: async () => {},
  };
}

/** The subset of `worker_threads.Worker` the client uses (a fake in tests). */
export interface WorkerLike {
  postMessage(msg: WorkerInbound): void;
  on(event: 'message', fn: (msg: WorkerOutbound) => void): unknown;
  on(event: 'error', fn: (err: Error) => void): unknown;
  on(event: 'exit', fn: (code: number) => void): unknown;
  terminate(): Promise<number>;
}

export interface WorkerEmbedderOptions {
  model: string;
  dtype: string;
  dims: number;
  modelsDir: string;
  allowRemote: boolean;
  /** Spawns the worker; default runs `embed-worker` in a worker thread. */
  createWorker?: () => WorkerLike;
  log?: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void; error: (o: object, m: string) => void };
  queryTimeoutMs?: number;
  queryCacheSize?: number;
  /** Restart backoff after a crash or failed load: base, max (ms). */
  backoffMs?: [number, number];
  /** Pending index batches beyond this are rejected (bounded queue). */
  maxQueue?: number;
  /** Called each time the model finishes loading (e.g. to kick the indexer). */
  onReady?: () => void;
}

interface Job {
  id: number;
  kind: EmbedKind;
  texts: string[];
  resolve: (v: Float32Array[]) => void;
  reject: (e: Error) => void;
  /** Set when the caller gave up (query timeout): the result is discarded. */
  abandoned?: boolean;
}

export function defaultWorkerFactory(): WorkerLike {
  // dev/tests run the .ts sources through tsx (inherited execArgv), production runs dist/*.js
  const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  return new Worker(new URL(`./embed-worker${ext}`, import.meta.url)) as unknown as WorkerLike;
}

/**
 * Main-thread client of the embedding worker (backend §11.3): one worker per replica, lazy
 * start (`warmUp`), one message in flight at a time so queries pre-empt queued index batches,
 * a 2 s query timeout, an LRU of 1,000 query vectors, and restart with exponential backoff.
 */
export class WorkerEmbedder implements Embedder {
  readonly modelId: string;
  dims: number;
  private readonly profile: ModelProfile;
  private state: EmbedderStatus = 'idle';
  private worker: WorkerLike | null = null;
  private readonly queue: Job[] = [];
  private inFlight: Job | null = null;
  private nextId = 1;
  private failures = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly cache = new Map<string, Float32Array>();
  private lastError: string | null = null;

  constructor(private readonly o: WorkerEmbedderOptions) {
    this.modelId = o.model;
    this.profile = modelProfile(o.model, o.dims);
    this.dims = this.profile.dims;
  }

  status(): EmbedderStatus {
    return this.state;
  }

  error(): string | null {
    return this.lastError;
  }

  warmUp(): void {
    if (this.closed || this.worker || this.restartTimer) return;
    this.spawn();
  }

  private spawn(): void {
    this.state = 'loading';
    const w = (this.o.createWorker ?? defaultWorkerFactory)();
    this.worker = w;
    w.on('message', (msg) => this.onMessage(w, msg));
    w.on('error', (err) => this.onCrash(w, err.message));
    w.on('exit', (code) => this.onCrash(w, `worker exited with code ${code}`));
    w.postMessage({ type: 'init', model: this.o.model, dtype: this.o.dtype, modelsDir: this.o.modelsDir, allowRemote: this.o.allowRemote, pooling: this.profile.pooling });
    this.o.log?.info({ model: this.o.model, dtype: this.o.dtype }, 'embedding worker starting');
  }

  private onMessage(w: WorkerLike, msg: WorkerOutbound): void {
    if (w !== this.worker) return;
    switch (msg.type) {
      case 'ready':
        this.state = 'ready';
        this.failures = 0;
        this.lastError = null;
        if (msg.dims !== this.dims) this.o.log?.warn({ expected: this.dims, actual: msg.dims }, 'embedding dimension differs from EMBEDDINGS_DIMS');
        this.dims = msg.dims;
        this.o.log?.info({ model: this.o.model, dims: msg.dims }, 'embedding model ready');
        this.pump();
        this.o.onReady?.();
        return;
      case 'init_error':
        this.fail(w, `embedding model failed to load: ${msg.message}`);
        return;
      case 'result':
      case 'error': {
        const job = this.inFlight;
        if (!job || job.id !== msg.id) return;
        this.inFlight = null;
        if (!job.abandoned) {
          if (msg.type === 'result') job.resolve(msg.vectors);
          else job.reject(new Error(msg.message));
        }
        this.pump();
        return;
      }
    }
  }

  private onCrash(w: WorkerLike, reason: string): void {
    if (w !== this.worker || this.closed) return;
    this.fail(w, reason);
  }

  private fail(w: WorkerLike, reason: string): void {
    this.lastError = reason;
    this.state = 'error';
    this.worker = null;
    void w.terminate().catch(() => {});
    const err = new EmbedderUnavailableError(reason);
    if (this.inFlight) this.inFlight.reject(err);
    this.inFlight = null;
    for (const j of this.queue.splice(0)) j.reject(err);
    this.failures += 1;
    const [base, max] = this.o.backoffMs ?? [1000, 300_000];
    const delay = Math.min(max, base * 2 ** (this.failures - 1));
    this.o.log?.error({ reason, retryInMs: delay }, 'embedding worker failed; restarting with backoff');
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.closed) this.spawn();
    }, delay);
    this.restartTimer.unref?.();
  }

  private pump(): void {
    if (this.state !== 'ready' || this.inFlight || !this.worker) return;
    for (let i = this.queue.length - 1; i >= 0; i--) if (this.queue[i]!.abandoned) this.queue.splice(i, 1);
    // queries first (FIFO within a kind)
    let idx = this.queue.findIndex((j) => j.kind === 'query' && !j.abandoned);
    if (idx < 0) idx = this.queue.length ? 0 : -1;
    if (idx < 0) return;
    const [job] = this.queue.splice(idx, 1);
    this.inFlight = job!;
    this.worker.postMessage({ type: 'embed', id: job!.id, texts: job!.texts });
  }

  private enqueue(kind: EmbedKind, texts: string[]): { job: Job; promise: Promise<Float32Array[]> } {
    let job!: Job;
    const promise = new Promise<Float32Array[]>((resolve, reject) => {
      job = { id: this.nextId++, kind, texts, resolve, reject };
    });
    this.queue.push(job);
    this.pump();
    return { job, promise };
  }

  async embedQuery(text: string, timeoutMs = this.o.queryTimeoutMs ?? 2000): Promise<Float32Array> {
    const input = `${this.profile.queryPrefix}${text}`;
    const hit = this.cache.get(input);
    if (hit) {
      this.cache.delete(input);
      this.cache.set(input, hit);
      return hit;
    }
    if (this.state !== 'ready') throw new EmbedderUnavailableError(`embedding model is ${this.state}`);
    const { job, promise } = this.enqueue('query', [input]);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        job.abandoned = true;
        reject(new EmbedderUnavailableError(`query embedding timed out after ${timeoutMs} ms`));
      }, timeoutMs);
    });
    try {
      const [v] = await Promise.race([promise, timeout]);
      this.cache.set(input, v!);
      const max = this.o.queryCacheSize ?? 1000;
      while (this.cache.size > max) this.cache.delete(this.cache.keys().next().value!);
      return v!;
    } finally {
      clearTimeout(timer);
    }
  }

  async embedDocuments(texts: readonly string[]): Promise<Float32Array[]> {
    if (!texts.length) return [];
    if (this.state !== 'ready') throw new EmbedderUnavailableError(`embedding model is ${this.state}`);
    if (this.queue.length >= (this.o.maxQueue ?? 64)) throw new EmbedderUnavailableError('embedding queue is full');
    return this.enqueue('index', [...texts]).promise;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const err = new EmbedderUnavailableError('embedder closed');
    if (this.inFlight) this.inFlight.reject(err);
    this.inFlight = null;
    for (const j of this.queue.splice(0)) j.reject(err);
    const w = this.worker;
    this.worker = null;
    this.state = 'idle';
    if (w) await w.terminate().catch(() => 0);
  }
}
