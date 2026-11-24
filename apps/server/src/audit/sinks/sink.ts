import type { AuditCheckpoint, AuditRow } from '../types.js';

/** A SIEM export target (§9.7). Delivery is at-least-once; receivers dedupe on `id`. */
export interface AuditSink {
  readonly name: string;
  deliver(batch: { rows: AuditRow[]; checkpoints: AuditCheckpoint[] }): Promise<void>;
}

export class SinkDeliveryError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
    this.name = 'SinkDeliveryError';
  }
}
