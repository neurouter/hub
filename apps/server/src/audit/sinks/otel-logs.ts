import { SeverityNumber, type Logger as OtelLogger } from '@opentelemetry/api';
import { exportRecord } from '../export.js';
import type { AuditCheckpoint, AuditRow } from '../types.js';
import type { AuditSink } from './sink.js';

/** Minimal provider surface (LoggerProvider from @opentelemetry/sdk-logs, or a fake in tests). */
export interface LogProviderLike {
  getLogger(name: string, version?: string): OtelLogger;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

/** Flattens a record into `neurouter.audit.*` attributes (objects as JSON strings). */
export function auditAttributes(rec: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (v === null || v === undefined) continue;
    out[`neurouter.audit.${k}`] = typeof v === 'object' ? JSON.stringify(v) : (v as string | number | boolean);
  }
  return out;
}

/** OTel logs sink (§9.7): one log record per audit row (and checkpoint), exported over OTLP HTTP. */
export class OtelLogsSink implements AuditSink {
  readonly name = 'otel_logs';
  private readonly logger: OtelLogger;

  constructor(private readonly provider: LogProviderLike) {
    this.logger = provider.getLogger('neurouter.audit');
  }

  async deliver(batch: { rows: AuditRow[]; checkpoints: AuditCheckpoint[] }): Promise<void> {
    for (const r of batch.rows) {
      const rec = exportRecord(r);
      const blocked = r.status === 'blocked';
      this.logger.emit({
        timestamp: Number(r.ts),
        severityNumber: blocked || r.status !== 'ok' ? SeverityNumber.WARN : SeverityNumber.INFO,
        severityText: blocked || r.status !== 'ok' ? 'WARN' : 'INFO',
        body: `${r.kind} ${r.tool_name ?? r.action ?? ''} ${r.decision} ${r.status}`.trim(),
        attributes: { 'event.name': 'neurouter.audit', ...auditAttributes(rec) },
      });
    }
    for (const c of batch.checkpoints) {
      this.logger.emit({
        timestamp: c.createdAt,
        severityNumber: SeverityNumber.INFO,
        severityText: 'INFO',
        body: `audit checkpoint ${c.kind} seq=${c.seq}`,
        attributes: { 'event.name': 'neurouter.audit.checkpoint', 'neurouter.audit.checkpoint.seq': c.seq, 'neurouter.audit.checkpoint.hash': c.hash, 'neurouter.audit.checkpoint.kind': c.kind, 'neurouter.audit.checkpoint.key_id': c.keyId, 'neurouter.audit.checkpoint.mac': c.mac },
      });
    }
    await this.provider.forceFlush();
  }
}

/** Real provider: LoggerProvider + BatchLogRecordProcessor(OTLPLogExporter) (standard OTEL_EXPORTER_OTLP_* env). */
export async function createOtlpLogProvider(): Promise<LogProviderLike> {
  const [{ LoggerProvider, BatchLogRecordProcessor }, { OTLPLogExporter }] = await Promise.all([import('@opentelemetry/sdk-logs'), import('@opentelemetry/exporter-logs-otlp-http')]);
  return new LoggerProvider({ processors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })] }) as unknown as LogProviderLike;
}
