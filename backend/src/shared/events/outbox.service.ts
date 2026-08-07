import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { Transaction } from 'kysely';
import { DatabaseService, type Database } from '../database';
import type {
  DomainEvent,
  EventToPublish,
  EventTypeValue,
  ClaimedDomainEvent,
} from './event-catalog';

/**
 * Transactional outbox.
 *
 * THE PROBLEM THIS SOLVES: if a service writes state to Postgres and then
 * pushes a job to Redis, the two are not atomic. A crash between them leaves
 * the system inconsistent in one of two ways:
 *
 *   - state committed, event lost  -> downstream never reacts (silent data loss)
 *   - event published, state rolled back -> subscribers act on a fact that
 *     never became true (phantom events)
 *
 * The outbox removes the window entirely: the event row is INSERTed in the SAME
 * transaction as the state change. Either both commit or neither does. A
 * separate relay then moves committed rows to BullMQ, retrying safely because
 * the row is durable.
 *
 * The cost is at-least-once delivery rather than exactly-once — the relay can
 * crash after publishing but before marking the row. Subscribers must therefore
 * be idempotent, which `IdempotentSubscriber` enforces.
 */
@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(private readonly database: DatabaseService) {}

  /**
   * Appends an event inside an EXISTING transaction.
   *
   * This is the correct way to publish. Pass the same `trx` the state change
   * used, so the event and its cause commit together.
   */
  async publishInTransaction<T extends EventTypeValue>(
    trx: Transaction<Database>,
    event: EventToPublish<T>,
  ): Promise<string> {
    const row = await trx
      .insertInto('capere.domain_events')
      .values({
        type: event.type,
        organization_id: event.organizationId,
        aggregate_type: event.aggregateType ?? null,
        aggregate_id: event.aggregateId ?? null,
        payload_version: event.payloadVersion ?? 1,
        payload: JSON.stringify(event.payload),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    return row.id;
  }

  /**
   * Publishes in its own transaction.
   *
   * Use ONLY when there is no accompanying state change — otherwise the
   * atomicity guarantee is lost, which is the entire point of the outbox.
   */
  async publish<T extends EventTypeValue>(event: EventToPublish<T>): Promise<string> {
    return this.database.transaction((trx) => this.publishInTransaction(trx, event));
  }

  /**
   * Claims a batch of unpublished events for the relay.
   *
   * `FOR UPDATE SKIP LOCKED` is what makes this safe to run in multiple worker
   * replicas: each relay locks a disjoint set of rows and no event is delivered
   * twice concurrently. Without SKIP LOCKED, relays would serialize behind each
   * other or double-publish.
   */
  async claimBatch(limit = 100): Promise<ClaimedDomainEvent[]> {
    return this.database.transaction(async (trx) => {
      const claimToken = randomUUID();
      const now = new Date();
      const staleBefore = new Date(now.getTime() - 5 * 60_000);
      const rows = await trx
        .selectFrom('capere.domain_events')
        .selectAll()
        .where('consumed_at', 'is', null)
        .where((eb) => eb.or([eb('claimed_at', 'is', null), eb('claimed_at', '<', staleBefore)]))
        .where((eb) => eb('attempts', '<', eb.ref('max_attempts')))
        .orderBy('created_at', 'asc')
        .limit(limit)
        .forUpdate()
        .skipLocked()
        .execute();

      if (rows.length === 0) return [];

      await trx
        .updateTable('capere.domain_events')
        .set({ claimed_at: now, claim_token: claimToken })
        .where(
          'id',
          'in',
          rows.map((r) => r.id),
        )
        .execute();

      return rows.map((row) => ({
        id: row.id,
        type: row.type as EventTypeValue,
        organizationId: row.organization_id,
        payload: (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as never,
        payloadVersion: row.payload_version,
        aggregateType: row.aggregate_type ?? undefined,
        aggregateId: row.aggregate_id ?? undefined,
        claimToken,
        occurredAt: row.created_at,
      }));
    });
  }

  /** Marks an event fully consumed. */
  async markConsumed(eventId: string, claimToken: string): Promise<void> {
    const updated = await this.database.db
      .updateTable('capere.domain_events')
      .set({
        consumed_at: new Date(),
        published_at: new Date(),
        claimed_at: null,
        claim_token: null,
      })
      .where('id', '=', eventId)
      .where('claim_token', '=', claimToken)
      .returning('id')
      .executeTakeFirst();

    if (!updated) {
      throw new Error(`Outbox claim for event ${eventId} is no longer owned by this worker`);
    }
  }

  /**
   * Records a delivery failure and releases the claim so it can be retried.
   *
   * When `attempts` reaches `max_attempts` the row stops being claimed and is
   * effectively dead-lettered — visible in the DLQ view rather than silently
   * retried forever.
   */
  async markFailed(eventId: string, claimToken: string, error: string): Promise<void> {
    const updated = await this.database.db
      .updateTable('capere.domain_events')
      .set((eb) => ({
        attempts: eb('attempts', '+', 1),
        last_error: error.slice(0, 2_000),
        claimed_at: null,
        claim_token: null,
      }))
      .where('id', '=', eventId)
      .where('claim_token', '=', claimToken)
      .returning(['attempts', 'max_attempts', 'type'])
      .executeTakeFirst();

    if (!updated) {
      throw new Error(`Outbox claim for event ${eventId} is no longer owned by this worker`);
    }

    // Warn loudly when an event exhausts its retries: it is now dead-lettered
    // and no subscriber will ever process it without operator action.
    if (updated.attempts >= updated.max_attempts) {
      this.logger.error(
        `Event ${eventId} (${updated.type}) dead-lettered after ${updated.attempts} attempts: ${error}`,
      );
    } else {
      this.logger.warn(
        `Event ${eventId} (${updated.type}) delivery failed ` +
          `(attempt ${updated.attempts}/${updated.max_attempts}): ${error}`,
      );
    }
  }

  /** Events that exhausted their retries. */
  async deadLettered(limit = 100): Promise<DomainEvent[]> {
    const rows = await this.database.db
      .selectFrom('capere.domain_events')
      .selectAll()
      .where((eb) => eb('attempts', '>=', eb.ref('max_attempts')))
      .where('consumed_at', 'is', null)
      .orderBy('created_at', 'desc')
      .limit(limit)
      .execute();

    return rows.map((row) => ({
      id: row.id,
      type: row.type as EventTypeValue,
      organizationId: row.organization_id,
      payload: (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as never,
      payloadVersion: row.payload_version,
      aggregateType: row.aggregate_type ?? undefined,
      aggregateId: row.aggregate_id ?? undefined,
      occurredAt: row.created_at,
    }));
  }

  /** Pending / dead-lettered counts for the monitoring endpoint. */
  async stats(): Promise<{ pending: number; deadLettered: number }> {
    const [pending, dead] = await Promise.all([
      this.database.db
        .selectFrom('capere.domain_events')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('consumed_at', 'is', null)
        .where((eb) => eb('attempts', '<', eb.ref('max_attempts')))
        .executeTakeFirstOrThrow(),
      this.database.db
        .selectFrom('capere.domain_events')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where((eb) => eb('attempts', '>=', eb.ref('max_attempts')))
        .where('consumed_at', 'is', null)
        .executeTakeFirstOrThrow(),
    ]);

    return { pending: Number(pending.count), deadLettered: Number(dead.count) };
  }
}
