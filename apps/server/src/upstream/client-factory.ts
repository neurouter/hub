import { Client, SSEClientTransport, StreamableHTTPClientTransport, type PriorDiscovery } from '@modelcontextprotocol/client';
import type { FetchLike } from '../lib/net/safe-fetch.js';

export type UpstreamEra = 'modern' | 'legacy' | 'legacy_sse';

export interface UpstreamTarget {
  url: string;
  transport: 'streamable_http' | 'sse';
  headers: Record<string, string>;
}

export interface ConnectedUpstream {
  client: Client;
  era: UpstreamEra;
  protocolVersion: string | null;
  serverInfo: UpstreamServerInfo | null;
  prior: PriorDiscovery | null;
}

export interface UpstreamServerInfo {
  name: string;
  version: string;
  icons?: unknown[];
}

export const GATEWAY_CLIENT_INFO = { name: 'neurouter-gateway', version: '0.1.1' } as const;

/**
 * Builds an SDK v2 client for an upstream (backend §5.7): Streamable HTTP with `server/discover`
 * negotiation and `initialize` fallback, or the legacy HTTP+SSE transport. A cached era verdict
 * (`prior`) skips the probe. The gateway declares no sampling/roots/elicitation capabilities and
 * handles `input_required` itself (manual MRTR mode).
 */
export async function connectUpstream(target: UpstreamTarget, fetchImpl: FetchLike, opts: { timeoutMs: number; prior?: PriorDiscovery | null; signal?: AbortSignal }): Promise<ConnectedUpstream> {
  const url = new URL(target.url);
  const requestInit = { headers: target.headers };
  if (target.transport === 'sse') {
    const client = new Client(GATEWAY_CLIENT_INFO, { capabilities: {} });
    await client.connect(new SSEClientTransport(url, { fetch: fetchImpl, requestInit, redirectPolicy: 'same-origin' }), { timeout: opts.timeoutMs, ...(opts.signal ? { signal: opts.signal } : {}) });
    return { client, era: 'legacy_sse', protocolVersion: client.getNegotiatedProtocolVersion() ?? null, serverInfo: info(client), prior: null };
  }
  const client = new Client(GATEWAY_CLIENT_INFO, { capabilities: {}, versionNegotiation: { mode: 'auto', probe: { timeoutMs: opts.timeoutMs } }, inputRequired: { autoFulfill: false } });
  const transport = new StreamableHTTPClientTransport(url, { fetch: fetchImpl, requestInit, redirectPolicy: 'same-origin' });
  await client.connect(transport, { timeout: opts.timeoutMs, ...(opts.prior ? { prior: opts.prior } : {}), ...(opts.signal ? { signal: opts.signal } : {}) });
  const era = client.getProtocolEra() === 'modern' ? 'modern' : 'legacy';
  const discover = client.getDiscoverResult();
  return {
    client,
    era,
    protocolVersion: client.getNegotiatedProtocolVersion() ?? null,
    serverInfo: info(client),
    prior: era === 'modern' && discover ? { kind: 'modern', discover } : { kind: 'legacy' },
  };
}

function info(client: Client): UpstreamServerInfo | null {
  const v = client.getServerVersion() as ({ name: unknown; version: unknown; icons?: unknown } | undefined);
  return v ? { name: String(v.name), version: String(v.version), ...(Array.isArray(v.icons) ? { icons: v.icons } : {}) } : null;
}
