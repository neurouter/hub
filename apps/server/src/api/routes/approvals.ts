import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { api } from '@neurouter/shared';
import type { Services } from '../../deps.js';
import { clientMeta, requireUser } from '../../auth/web/guards.js';
import { sseFrame } from '../../policy/approvals/stream.js';
import { registerEndpoint } from '../routes.js';

/** SSE keep-alive comment interval (backend §12.2; survives 60 s LB idle timeouts). */
export const SSE_KEEPALIVE_MS = 15_000;

/** Step 9: approvals list / detail / decisions and the live SSE stream. */
export async function approvalRoutes(app: FastifyInstance, s: Services, opts: { keepAliveMs?: number } = {}): Promise<void> {
  const live = new Set<() => void>();
  app.addHook('onClose', async () => {
    for (const close of [...live]) close();
  });

  registerEndpoint(app, api.approvals.list, async (req) => s.approvals.list(req.query, requireUser(req)));

  registerEndpoint(app, api.approvals.stream, async (req, reply) => {
    const viewer = requireUser(req);
    const out = new PassThrough();
    let open = true;
    const write = (chunk: string) => {
      if (open) out.write(chunk);
    };
    // tell EventSource how long to wait before reconnecting, then confirm the stream is live
    write(`retry: 3000\n: connected\n\n`);
    const remove = await s.approvalStream.connect({ viewer, send: (event, id, data) => write(sseFrame(event, id, data)) }, req.headers['last-event-id'] as string | undefined);
    const ping = setInterval(() => write(`: keep-alive ${Date.now()}\n\n`), opts.keepAliveMs ?? SSE_KEEPALIVE_MS);
    const close = () => {
      if (!open) return;
      open = false;
      live.delete(close);
      clearInterval(ping);
      remove();
      out.end();
    };
    live.add(close);
    req.raw.once('close', close);
    reply
      .header('content-type', 'text/event-stream; charset=utf-8')
      .header('cache-control', 'no-cache, no-transform')
      .header('x-accel-buffering', 'no')
      .header('connection', 'keep-alive');
    reply.send(out);
    return reply;
  });

  registerEndpoint(app, api.approvals.get, async (req) => s.approvals.get(req.params.id, requireUser(req)));
  registerEndpoint(app, api.approvals.approve, async (req) => s.approvals.decide(req.params.id, 'approved', requireUser(req), req.body.note?.trim() || null, clientMeta(req)));
  registerEndpoint(app, api.approvals.deny, async (req) => s.approvals.decide(req.params.id, 'denied', requireUser(req), req.body.reason, clientMeta(req)));
}
