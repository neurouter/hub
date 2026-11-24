import type { FastifyInstance } from 'fastify';

/** A WHATWG `fetch` backed by `fastify.inject` (no sockets), for driving `/mcp` with the SDK client. */
export function injectFetch(app: FastifyInstance, extraHeaders: Record<string, string> = {}) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    const headers: Record<string, string> = { ...extraHeaders };
    req.headers.forEach((v, k) => (headers[k] = v));
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text();
    const res = await app.inject({ method: req.method as 'GET', url: url.pathname + url.search, headers, ...(body !== undefined ? { payload: body } : {}) });
    const h = new Headers();
    for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(', ') : String(v));
    return new Response(res.statusCode === 204 || res.statusCode === 304 ? null : res.rawPayload, { status: res.statusCode, headers: h });
  };
}
