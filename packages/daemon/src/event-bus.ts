import type { AgentEvent } from "@bullpen/core";

export type EventHandler = (event: AgentEvent) => void;

/**
 * Minimal synchronous pub/sub. Handlers must not throw; errors are isolated
 * so one bad subscriber can't break ingestion.
 */
export class EventBus {
  private handlers = new Set<EventHandler>();

  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(event: AgentEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[event-bus] handler error", err);
      }
    }
  }
}
