import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OutboxService } from '../src/shared/events';
import type { DatabaseService, Database } from '../src/shared/database';
import type { Transaction } from 'kysely';
import { EventType } from '../src/shared/events';
import {
  cleanup,
  closeDb,
  seedTwoOrganizations,
  serviceDb,
  type Fixture,
} from './helpers/database';

describe('OutboxService reliability', () => {
  let fixture: Fixture;
  let outbox: OutboxService;

  beforeAll(async () => {
    fixture = await seedTwoOrganizations();
    outbox = new OutboxService({
      db: serviceDb(),
      transaction: <T>(fn: (trx: Transaction<Database>) => Promise<T>) =>
        serviceDb().transaction().execute(fn),
    } as unknown as DatabaseService);
  });

  beforeEach(async () => {
    // The relay is intentionally global; isolate this contract suite from
    // events emitted by other integration fixtures in the shared test DB.
    await serviceDb().deleteFrom('capere.domain_events').execute();
  });

  afterAll(async () => {
    await cleanup(fixture);
    await closeDb();
  });

  it('claims, consumes, and excludes an event from pending work', async () => {
    const id = await publish();
    const [claimed] = await outbox.claimBatch();
    expect(claimed.id).toBe(id);
    expect(claimed.claimToken).toMatch(/^[0-9a-f-]{36}$/);

    await outbox.markConsumed(id, claimed.claimToken);
    await expect(outbox.claimBatch()).resolves.toEqual([]);
    await expect(outbox.stats()).resolves.toEqual({ pending: 0, deadLettered: 0 });
  });

  it('rejects stale workers with the wrong claim token', async () => {
    const id = await publish();
    await outbox.claimBatch();
    await expect(outbox.markConsumed(id, randomUUID())).rejects.toThrow(/no longer owned/);
    await expect(outbox.markFailed(id, randomUUID(), 'late failure')).rejects.toThrow(
      /no longer owned/,
    );
  });

  it('releases a failed claim for retry and dead-letters exhausted events', async () => {
    const id = await publish();

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const [claimed] = await outbox.claimBatch();
      expect(claimed.id).toBe(id);
      await outbox.markFailed(id, claimed.claimToken, `failure-${attempt}`);
    }

    await expect(outbox.claimBatch()).resolves.toEqual([]);
    await expect(outbox.stats()).resolves.toEqual({ pending: 0, deadLettered: 1 });
    await expect(outbox.deadLettered()).resolves.toEqual([
      expect.objectContaining({ id, organizationId: fixture.orgAId }),
    ]);
  });

  it('reclaims a stale claim after the lease expires', async () => {
    const id = await publish();
    const [first] = await outbox.claimBatch();
    await serviceDb()
      .updateTable('capere.domain_events')
      .set({ claimed_at: new Date(Date.now() - 6 * 60_000) })
      .where('id', '=', id)
      .execute();

    const [reclaimed] = await outbox.claimBatch();
    expect(reclaimed.id).toBe(id);
    expect(reclaimed.claimToken).not.toBe(first.claimToken);
  });

  function publish() {
    return outbox.publish({
      type: EventType.IntegrationConnected,
      organizationId: fixture.orgAId,
      payload: { integrationId: randomUUID(), provider: 'test' },
    });
  }
});
