import type { Embedder, EmbedderStatus } from '../../search/embedder.js';
import { EmbedderUnavailableError } from '../../search/embedder.js';
import { sha256 } from '../../lib/crypto.js';

/** Crude English stemmer so "issues"/"issue", "creating"/"create" share a bucket. */
function stem(t: string): string {
  return t.replace(/(ing|ed|es|s)$/u, '') || t;
}

/**
 * Deterministic bag-of-words embedder for unit tests (no model, no network): each token is
 * hashed into a few of `dims` buckets, plus optional synonym groups mapped to the same token,
 * then L2-normalized. Cosine similarity then tracks token overlap, which is enough to test
 * hybrid ranking logic.
 */
export class FakeEmbedder implements Embedder {
  readonly modelId: string;
  readonly dims: number;
  state: EmbedderStatus = 'ready';
  calls: Array<{ kind: 'query' | 'index'; texts: string[] }> = [];
  /** Optional delay (ms) for query embeddings (timeout tests). */
  queryDelayMs = 0;
  private readonly synonyms = new Map<string, string>();

  constructor(opts: { modelId?: string; dims?: number; synonyms?: string[][] } = {}) {
    this.modelId = opts.modelId ?? 'fake-embedder';
    this.dims = opts.dims ?? 384;
    for (const group of opts.synonyms ?? []) for (const w of group) this.synonyms.set(stem(w), stem(group[0]!));
  }

  status(): EmbedderStatus {
    return this.state;
  }
  warmUp(): void {}

  vector(text: string): Float32Array {
    const v = new Float32Array(this.dims);
    for (const raw of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
      const tok = this.synonyms.get(stem(raw)) ?? stem(raw);
      const h = sha256(tok);
      for (let i = 0; i < 3; i++) v[h.readUInt16BE(i * 2) % this.dims]! += h[8 + i]! & 1 ? 1 : -1;
    }
    let n = 0;
    for (const x of v) n += x * x;
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++) v[i]! /= n;
    return v;
  }

  async embedQuery(text: string): Promise<Float32Array> {
    if (this.state !== 'ready') throw new EmbedderUnavailableError(`fake embedder is ${this.state}`);
    this.calls.push({ kind: 'query', texts: [text] });
    if (this.queryDelayMs) await new Promise((r) => setTimeout(r, this.queryDelayMs));
    return this.vector(text);
  }

  async embedDocuments(texts: readonly string[]): Promise<Float32Array[]> {
    if (this.state !== 'ready') throw new EmbedderUnavailableError(`fake embedder is ${this.state}`);
    this.calls.push({ kind: 'index', texts: [...texts] });
    return texts.map((t) => this.vector(t));
  }

  async close(): Promise<void> {}
}
