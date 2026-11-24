/** Per-model options (backend §11.2). All three Phase 1 models produce 384-dim vectors. */
export interface ModelProfile {
  pooling: 'cls' | 'mean';
  /** Prepended to queries (not to documents). */
  queryPrefix: string;
  dims: number;
}

const RETRIEVAL_PREFIX = 'Represent this sentence for searching relevant passages: ';

export const DEFAULT_EMBEDDING_MODEL = 'onnx-community/granite-embedding-small-english-r2-ONNX';

export const MODEL_PROFILES: Readonly<Record<string, ModelProfile>> = {
  [DEFAULT_EMBEDDING_MODEL]: { pooling: 'cls', queryPrefix: '', dims: 384 },
  'Snowflake/snowflake-arctic-embed-s': { pooling: 'cls', queryPrefix: RETRIEVAL_PREFIX, dims: 384 },
  'Xenova/bge-small-en-v1.5': { pooling: 'cls', queryPrefix: RETRIEVAL_PREFIX, dims: 384 },
};

/** Unknown models: mean pooling, no prefix, dims from config. */
export function modelProfile(model: string, dims: number): ModelProfile {
  return MODEL_PROFILES[model] ?? { pooling: 'mean', queryPrefix: '', dims };
}
