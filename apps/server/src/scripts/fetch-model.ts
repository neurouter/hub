/**
 * Downloads the embedding model into MODELS_DIR (backend §11.3 / §16.1) so the image (or an
 * air-gapped host) can run with EMBEDDINGS_ALLOW_REMOTE=false.
 *
 *   npm run models:fetch -w @neurouter/server
 *   EMBEDDINGS_MODEL=… EMBEDDINGS_DTYPE=q8 MODELS_DIR=/app/models node dist/scripts/fetch-model.js
 *
 * After downloading it embeds two sentences and prints the vector size as a smoke test.
 */
import { isAbsolute, resolve } from 'node:path';
import { SERVER_PACKAGE_DIR } from '../config/load.js';
import { DEFAULT_EMBEDDING_MODEL, modelProfile } from '../search/model-profiles.js';

async function main(): Promise<void> {
  const model = process.env.EMBEDDINGS_MODEL || DEFAULT_EMBEDDING_MODEL;
  const dtype = (process.env.EMBEDDINGS_DTYPE || 'q8') as 'q8';
  const dirEnv = process.env.MODELS_DIR || './models';
  const modelsDir = isAbsolute(dirEnv) ? dirEnv : resolve(SERVER_PACKAGE_DIR, dirEnv);
  const profile = modelProfile(model, Number(process.env.EMBEDDINGS_DIMS || 384));
  const t = await import('@huggingface/transformers');
  t.env.allowRemoteModels = true;
  t.env.localModelPath = modelsDir;
  t.env.cacheDir = modelsDir;
  t.env.useFSCache = true;
  console.log(`fetching ${model} (${dtype}) into ${modelsDir}`);
  const started = Date.now();
  const extractor = await t.pipeline('feature-extraction', model, { dtype, device: 'cpu' });
  const out = await extractor(['create a github issue', 'list kubernetes pods'], { pooling: profile.pooling, normalize: true });
  console.log(`ok: dims=${out.dims.at(-1)} in ${Date.now() - started} ms`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
