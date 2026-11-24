import type { ServerEvent, ServerEventBus } from '@modelcontextprotocol/server';
import type { CoordinationStore, Json } from '../coordination/types.js';

export const MCP_EVENTS_CHANNEL = 'mcp.events';

/**
 * Multi-replica `ServerEventBus` (backend §12.3): `publish` fans out through the coordination
 * store; every replica delivers to its local `subscriptions/listen` streams. Events are global
 * "list changed" signals; clients re-fetch per-principal lists, so nothing leaks.
 */
export class CoordinationEventBus implements ServerEventBus {
  private readonly listeners = new Set<(e: ServerEvent) => void>();
  private readonly unsubscribe: () => void;

  constructor(private readonly coord: CoordinationStore) {
    this.unsubscribe = coord.subscribe(MCP_EVENTS_CHANNEL, (payload) => {
      for (const l of [...this.listeners]) {
        try {
          l(payload as unknown as ServerEvent);
        } catch {
          // a throwing listener must not stop delivery to the others
        }
      }
    });
  }

  publish(event: ServerEvent): void {
    void this.coord.publish(MCP_EVENTS_CHANNEL, event as unknown as Json);
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  close(): void {
    this.unsubscribe();
    this.listeners.clear();
  }
}
