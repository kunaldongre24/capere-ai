import { Injectable, Logger } from '@nestjs/common';
import type { DomainEvent, EventTypeValue } from './event-catalog';

/**
 * A subscriber that handles one event type.
 *
 * Handlers MUST be idempotent. The outbox relay guarantees at-least-once
 * delivery, so the same event can arrive twice — after a relay crash between
 * publishing and marking the row, or after a retry. A handler that is not
 * idempotent will double-charge, double-notify, or double-insert.
 */
export interface EventSubscriber<T extends EventTypeValue = EventTypeValue> {
  /** Stable name; also the idempotency scope for this subscriber. */
  readonly name: string;
  readonly eventType: T;
  handle(event: DomainEvent<T>): Promise<void>;
}

/**
 * In-process event bus.
 *
 * The second tier of the two-tier design. Two distinct delivery paths exist on
 * purpose:
 *
 *   - **In-process (this class)** — synchronous, same transaction, no
 *     durability. For work that must happen with the state change and is cheap:
 *     cache invalidation, in-memory projections.
 *
 *   - **Outbox -> BullMQ** — durable, asynchronous, retried. For work that must
 *     not be lost and may be slow: sending mail, calling partner APIs,
 *     regenerating insights.
 *
 * Using one mechanism for both would mean either paying queue latency for
 * trivial work or losing important work on a crash.
 *
 * A failing in-process handler is logged and swallowed, never propagated: a
 * subscriber must not be able to fail the publisher's request. Work that MUST
 * succeed belongs in the durable path, where it is retried.
 */
@Injectable()
export class InProcessEventBus {
  private readonly logger = new Logger(InProcessEventBus.name);
  private readonly subscribers = new Map<string, EventSubscriber[]>();

  subscribe<T extends EventTypeValue>(subscriber: EventSubscriber<T>): void {
    const existing = this.subscribers.get(subscriber.eventType) ?? [];
    existing.push(subscriber as EventSubscriber);
    this.subscribers.set(subscriber.eventType, existing);
    this.logger.debug(`${subscriber.name} subscribed to ${subscriber.eventType}`);
  }

  /**
   * Delivers to every subscriber for this event type.
   *
   * Handlers run concurrently and independently: one throwing does not prevent
   * the others from running, and none can reject the caller.
   */
  async emit<T extends EventTypeValue>(event: DomainEvent<T>): Promise<void> {
    const handlers = this.subscribers.get(event.type);
    if (!handlers || handlers.length === 0) return;

    await Promise.all(
      handlers.map(async (subscriber) => {
        try {
          await subscriber.handle(event as DomainEvent);
        } catch (error) {
          this.logger.error(
            `Subscriber ${subscriber.name} failed on ${event.type} (${event.id}): ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }),
    );
  }

  /** Subscriber names by event type — used by the monitoring endpoint. */
  registrations(): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const [eventType, handlers] of this.subscribers) {
      result[eventType] = handlers.map((h) => h.name);
    }
    return result;
  }
}
