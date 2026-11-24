/**
 * Embedding worker thread (backend §11.3). Loads the Transformers.js feature-extraction pipeline
 * lazily on `init` (this is the only place the model is loaded or downloaded) and answers
 * `embed` messages one at a time. Vectors are transferred, not copied.
 *
 * Messages in:  { type: 'init', model, dtype, modelsDir, allowRemote, pooling }
 *               { type: 'embed', id, texts }
 * Messages out: { type: 'ready', dims } | { type: 'init_error', message }
 *               { type: 'result', id, vectors } | { type: 'error', id, message }
 */
import { parentPort } from 'node:worker_threads';
import type { WorkerInbound, WorkerOutbound } from './embedder.js';

type Extractor = (texts: string[], opts: { pooling: 'cls' | 'mean'; normalize: boolean }) => Promise<{ data: Float32Array; dims: number[] }>;

let extractor: Extractor | null = null;
let pooling: 'cls' | 'mean' = 'cls';

const post = (msg: WorkerOutbound, transfer: ArrayBuffer[] = []) => parentPort!.postMessage(msg, transfer);

async function init(msg: Extract<WorkerInbound, { type: 'init' }>): Promise<void> {
  try {
    const t = await import('@huggingface/transformers');
    t.env.allowRemoteModels = msg.allowRemote;
    t.env.allowLocalModels = true;
    t.env.localModelPath = msg.modelsDir;
    t.env.cacheDir = msg.modelsDir;
    // cache writes only happen when downloading; air-gapped images run with a read-only root filesystem
    t.env.useFSCache = msg.allowRemote;
    pooling = msg.pooling;
    const pipe = await t.pipeline('feature-extraction', msg.model, { dtype: msg.dtype as 'q8', device: 'cpu' });
    extractor = pipe as unknown as Extractor;
    // warm-up pass also reports the real output dimension
    const probe = await extractor(['warm-up'], { pooling, normalize: true });
    post({ type: 'ready', dims: probe.dims[probe.dims.length - 1]! });
  } catch (err) {
    post({ type: 'init_error', message: (err as Error).message ?? String(err) });
  }
}

async function embed(msg: Extract<WorkerInbound, { type: 'embed' }>): Promise<void> {
  try {
    if (!extractor) throw new Error('embedding model is not loaded');
    const out = await extractor(msg.texts, { pooling, normalize: true });
    const d = out.dims[out.dims.length - 1]!;
    const vectors: Float32Array[] = [];
    for (let i = 0; i < msg.texts.length; i++) vectors.push(out.data.slice(i * d, (i + 1) * d));
    post({ type: 'result', id: msg.id, vectors }, vectors.map((v) => v.buffer as ArrayBuffer));
  } catch (err) {
    post({ type: 'error', id: msg.id, message: (err as Error).message ?? String(err) });
  }
}

// messages are handled strictly in order: the main thread sends one embed at a time
let chain: Promise<void> = Promise.resolve();
parentPort?.on('message', (msg: WorkerInbound) => {
  chain = chain.then(() => (msg.type === 'init' ? init(msg) : embed(msg)));
});
