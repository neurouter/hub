import type { FastifyInstance } from 'fastify';
import { api } from '@neurouter/shared';
import type { Services } from '../../deps.js';
import { clientMeta, requireAdmin, requireUser } from '../../auth/web/guards.js';
import { AppError } from '../../lib/errors.js';
import { rotateKeys } from '../../secrets/rotation.js';
import { registerEndpoint } from '../routes.js';

/** Admin system operations: search reindex (step 8) and key rotation (§8; checkpoints the audit chain first). */
export async function systemRoutes(app: FastifyInstance, s: Services): Promise<void> {
  registerEndpoint(app, api.system.names, async (req) => s.nameLookup.names(req.query.ids, requireUser(req)));

  registerEndpoint(app, api.system.reindex, async (req) => {
    const admin = requireAdmin(req);
    const st = s.embedder.status();
    if (st === 'disabled') throw AppError.conflict('Embeddings are disabled (EMBEDDINGS_ENABLED=false); search is keyword-only');
    if (st !== 'ready') throw AppError.conflict(`The embedding model is not ready yet (${st}); retry when it has loaded`);
    const jobId = await s.jobs.start('reindex', { model: s.embedder.modelId }, admin.id, (progress) => s.indexer.reindex(progress));
    s.audit.admin({ actorUserId: admin.id, action: 'search.reindex', targetType: 'system', targetId: null, after: { jobId, model: s.embedder.modelId }, ...clientMeta(req) });
    return { jobId };
  });

  registerEndpoint(app, api.system.rotateKeys, async (req) => {
    const admin = requireAdmin(req);
    const type = req.body.type;
    const jobId = await s.jobs.start('key_rotation', { type }, admin.id, async () => {
      // keep older checkpoints verifiable: seal the chain under the current key first (§8)
      await s.auditStore.checkpoint('key_rotation');
      return rotateKeys({ db: s.dbs.main.db, envelope: s.envelope, secrets: s.secrets, extraReencrypt: (dekId) => s.upstreamOAuth.reencryptAll(dekId) }, type);
    });
    s.audit.admin({ actorUserId: admin.id, action: 'keys.rotate', targetType: 'system', targetId: null, after: { jobId, type }, ...clientMeta(req) });
    return { jobId };
  });
}
