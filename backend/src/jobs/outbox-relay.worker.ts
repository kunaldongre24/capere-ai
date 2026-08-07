import { Injectable, Logger } from '@nestjs/common';
import { InProcessEventBus, OutboxService } from '../shared/events';
import { InsightsEngine } from '../insights';

/**
 * The outbox relay.
 *
 * Completes the two-tier event bus: `domain_events` rows are written atomically
 * with the state change that caused them, and this relay is what actually
 * delivers them.
 *
 *   claim a batch (FOR UPDATE SKIP LOCKED)
 *     -> dispatch to subscribers
 *     -> mark consumed, or record the failure and release for retry
 *
 * DELIVERY SEMANTICS are at-least-once, deliberately. The relay can crash after
 * a subscriber succeeds but before the row is marked consumed, so the event is
 * redelivered. Subscribers must therefore be idempotent — which is why the
 * insights engine deduplicates on `dedupe_key` rather than assuming it sees each
 * event exactly once. Exactly-once would require distributed transactions
 * across Postgres and every subscriber's side effects, which is not worth it.
 *
 * SKIP LOCKED is what makes this safe to run in several worker replicas: each
 * claims a disjoint set of rows.
 */
@Injectable()
export class OutboxRelayWorker {
  private readonly logger = new Logger(OutboxRelayWorker.name);
  private running = false;
  private timer?: NodeJS.Timeout;
  private wake?: () => void;
  private loopPromise?: Promise<void>;

  /** Polling interval when the last pass found nothing. */
  private static readonly IDLE_INTERVAL_MS = 2_000;
  /** When a full batch was drained, poll again immediately. */
  private static readonly BUSY_INTERVAL_MS = 50;
  private static readonly BATCH_SIZE = 50;

  constructor(
    private readonly outbox: OutboxService,
    private readonly bus: InProcessEventBus,
    private readonly insights: InsightsEngine,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.logger.log('Outbox relay started');
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loopPromise;
    this.loopPromise = undefined;
    this.logger.log('Outbox relay stopped');
  }

  /**
   * One pass. Exposed so tests can drive the relay deterministically instead of
   * waiting on a timer.
   *
   * @returns how many events were processed.
   */
  async tick(): Promise<number> {
    const events = await this.outbox.claimBatch(OutboxRelayWorker.BATCH_SIZE);
    if (events.length === 0) return 0;

    for (const event of events) {
      try {
        // In-process subscribers first — cheap, same-process handlers.
        await this.bus.emit(event);

        // Then the insights engine, which is the one real subscriber in Phase 1.
        await this.insights.runForEvent(event);

        await this.outbox.markConsumed(event.id, event.claimToken);
      } catch (error) {
        // markFailed increments attempts and releases the claim; once attempts
        // reaches max_attempts the row stops being claimed and is visible in
        // the DLQ view rather than retried forever.
        await this.outbox.markFailed(
          event.id,
          event.claimToken,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    return events.length;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let processed = 0;

      try {
        processed = await this.tick();
      } catch (error) {
        // A database blip must not kill the relay permanently.
        this.logger.error(
          `Relay pass failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const delay =
        processed >= OutboxRelayWorker.BATCH_SIZE
          ? OutboxRelayWorker.BUSY_INTERVAL_MS
          : OutboxRelayWorker.IDLE_INTERVAL_MS;

      await new Promise<void>((resolve) => {
        this.wake = () => {
          if (this.timer) clearTimeout(this.timer);
          this.timer = undefined;
          this.wake = undefined;
          resolve();
        };
        this.timer = setTimeout(this.wake, delay);
      });
    }
  }

  /** Outbox depth and dead-letter count, for the monitoring endpoint. */
  async stats(): Promise<{ pending: number; deadLettered: number }> {
    return this.outbox.stats();
  }
}
