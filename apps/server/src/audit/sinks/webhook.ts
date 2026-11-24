import { hmacSha256Hex } from '../../lib/crypto.js';
import type { FetchLike } from '../../lib/net/safe-fetch.js';
import { exportRecord } from '../export.js';
import type { AuditCheckpoint, AuditRow } from '../types.js';
import { SinkDeliveryError, type AuditSink } from './sink.js';

export const SIGNATURE_HEADER = 'X-Neurouter-Signature';

/** `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + body)>` */
export function signWebhook(secret: string, body: string, nowMs: number): string {
  const t = Math.floor(nowMs / 1000);
  return `t=${t},v1=${hmacSha256Hex(secret, `${t}.${body}`)}`;
}

/** Receiver-side check (documented for integrators; also used in tests). */
export function verifyWebhookSignature(secret: string, body: string, header: string, nowMs: number, toleranceSec = 300): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=', 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(nowMs / 1000 - t) > toleranceSec) return false;
  return parts.v1 === hmacSha256Hex(secret, `${t}.${body}`);
}

/** One NDJSON line per audit row (`type: "event"`) and per checkpoint (`type: "checkpoint"`). */
export function webhookBody(rows: AuditRow[], checkpoints: AuditCheckpoint[]): string {
  const lines = rows.map((r) => JSON.stringify({ type: 'event', ...exportRecord(r) }));
  for (const c of checkpoints) lines.push(JSON.stringify({ type: 'checkpoint', id: c.id, seq: c.seq, hash: c.hash, kind: c.kind, keyId: c.keyId, mac: c.mac, createdAt: new Date(c.createdAt).toISOString() }));
  return lines.length ? `${lines.join('\n')}\n` : '';
}

/** Signed NDJSON POST through the SSRF-guarded outbound fetch (§9.7). */
export class WebhookSink implements AuditSink {
  readonly name = 'webhook';
  constructor(private readonly o: { url: string; secret: () => Promise<string | null>; fetch: FetchLike; now: () => number }) {}

  async post(body: string): Promise<{ status: number }> {
    const secret = await this.o.secret();
    const headers: Record<string, string> = { 'content-type': 'application/x-ndjson', 'user-agent': 'neurouter-audit-webhook' };
    if (secret) headers[SIGNATURE_HEADER.toLowerCase()] = signWebhook(secret, body, this.o.now());
    const res = await this.o.fetch(this.o.url, { method: 'POST', headers, body });
    await res.body?.cancel().catch(() => {});
    if (res.status < 200 || res.status >= 300) throw new SinkDeliveryError(`webhook responded ${res.status}`, res.status);
    return { status: res.status };
  }

  async deliver(batch: { rows: AuditRow[]; checkpoints: AuditCheckpoint[] }): Promise<void> {
    const body = webhookBody(batch.rows, batch.checkpoints);
    if (body) await this.post(body);
  }
}
