import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { EndpointBody, EndpointDef, EndpointParams, EndpointQuery, EndpointResponse } from '@neurouter/shared';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Contract access levels of the route (set by registerEndpoint). */
    access?: readonly string[];
  }
}

export interface EndpointRequest<D extends EndpointDef> extends FastifyRequest {
  params: EndpointParams<D> extends undefined ? Record<string, never> : EndpointParams<D>;
  query: EndpointQuery<D> extends undefined ? Record<string, never> : EndpointQuery<D>;
  body: EndpointBody<D>;
}

export type EndpointHandler<D extends EndpointDef> = (
  req: EndpointRequest<D>,
  reply: FastifyReply,
) => Promise<EndpointResponse<D> | void> | EndpointResponse<D> | void;

/**
 * Registers a route straight from the shared contract: method, path, zod schemas for
 * params/query/body and the success response (validated by fastify-type-provider-zod).
 * Every server route must go through this so the server and web client can't drift.
 */
export function registerEndpoint<D extends EndpointDef>(
  app: FastifyInstance,
  def: D,
  handler: EndpointHandler<D>,
  opts: Pick<RouteShorthandOptions, 'preHandler' | 'preValidation' | 'onRequest' | 'config' | 'bodyLimit'> = {},
): void {
  const schema: Record<string, unknown> = {};
  if (def.params) schema.params = def.params;
  if (def.query) schema.querystring = def.query;
  if (def.body) schema.body = def.body;
  if (def.response && def.kind === 'json') schema.response = { [def.status]: def.response };
  app.withTypeProvider<ZodTypeProvider>().route({
    method: def.method,
    url: def.path,
    schema,
    ...opts,
    // the contract's access levels drive the coarse auth gate (installWebAuth) before validation
    config: { ...((opts.config as object | undefined) ?? {}), access: def.access },
    handler: async (req, reply) => {
      const out = await handler(req as unknown as EndpointRequest<D>, reply);
      if (reply.sent) return reply;
      if (def.kind === 'empty') return reply.status(204).send();
      reply.status(def.status);
      return out;
    },
  });
}
