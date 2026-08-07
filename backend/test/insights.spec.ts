import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FeatureFlagService } from '../src/feature-flags';
import { IntegrationHealthGenerator } from '../src/insights/generators/integration-health.generator';
import { InsightsEngine } from '../src/insights/insights.engine';
import { OutboxService } from '../src/shared/events';
import type { DatabaseService } from '../src/shared/database';
import {
  cleanup,
  closeDb,
  seedTwoOrganizations,
  serviceDb,
  type Fixture,
} from './helpers/database';

/**
 * Insights engine against a real database.
 *
 * The properties that matter:
 *   - deduplication (a re-detected condition must not pile up duplicates)
 *   - the InsightGenerated outbox event fires exactly once, on creation
 *   - tenant isolation (an insight for org A never appears for org B)
 */
function makeDatabase(): DatabaseService {
  return {
    db: serviceDb(),
    transaction: <T>(fn: (trx: unknown) => Promise<T>) =>
      serviceDb()
        .transaction()
        .execute((trx) => fn(trx)),
  } as unknown as DatabaseService;
}

describe('InsightsEngine', () => {
  let fixture: Fixture;
  let engine: InsightsEngine;
  let generator: IntegrationHealthGenerator;
  let database: DatabaseService;

  beforeAll(async () => {
    fixture = await seedTwoOrganizations();
    database = makeDatabase();
    generator = new IntegrationHealthGenerator(database);

    const flags = new FeatureFlagService(database);
    const outbox = new OutboxService(database);
    engine = new InsightsEngine(database, outbox, flags, [generator]);
  });

  afterAll(async () => {
    await cleanup(fixture);
    await closeDb();
  });

  it('registers its generators', () => {
    expect(engine.registered()).toContain('integration_health');
  });

  it('produces no insights when there are no integrations', async () => {
    expect(await engine.runAll(fixture.orgBId)).toBe(0);
  });

  it('flags a disconnected integration', async () => {
    await serviceDb()
      .insertInto('capere.integrations')
      .values({
        organization_id: fixture.orgAId,
        provider: 'google_analytics_4',
        status: 'disconnected',
      })
      .execute();

    expect(await engine.runAll(fixture.orgAId)).toBe(1);

    const active = await engine.active(fixture.orgAId);
    expect(active).toHaveLength(1);
    expect(active[0].title).toContain('Google Analytics 4');
    expect(active[0].severity).toBe('medium');
  });

  it('publishes InsightGenerated to the outbox exactly once', async () => {
    const events = await serviceDb()
      .selectFrom('capere.domain_events')
      .select(['type', 'organization_id'])
      .where('organization_id', '=', fixture.orgAId)
      .where('type', '=', 'insight.generated')
      .execute();

    expect(events).toHaveLength(1);
  });

  it('deduplicates a re-detected condition instead of accumulating rows', async () => {
    // The same disconnection detected again — an hourly sweep must not create
    // 24 identical insights a day.
    expect(await engine.runAll(fixture.orgAId)).toBe(0);

    const active = await engine.active(fixture.orgAId);
    expect(active).toHaveLength(1);

    // And no second event: the user already knows.
    const events = await serviceDb()
      .selectFrom('capere.domain_events')
      .select('id')
      .where('organization_id', '=', fixture.orgAId)
      .where('type', '=', 'insight.generated')
      .execute();
    expect(events).toHaveLength(1);
  });

  it('escalates severity when an integration moves to an error state', async () => {
    await serviceDb()
      .updateTable('capere.integrations')
      .set({ status: 'error', last_error: 'invalid_grant' })
      .where('organization_id', '=', fixture.orgAId)
      .where('provider', '=', 'google_analytics_4')
      .execute();

    await engine.runAll(fixture.orgAId);

    const active = await engine.active(fixture.orgAId);
    const errorInsight = active.find((i) => i.title.includes('reporting an error'));
    expect(errorInsight).toBeDefined();
    expect(errorInsight?.severity).toBe('high');
    expect(errorInsight?.body).toContain('invalid_grant');
  });

  it('flags a connected-but-stale integration', async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3_600_000);
    await serviceDb()
      .insertInto('capere.integrations')
      .values({
        organization_id: fixture.orgAId,
        provider: 'google_search_console',
        status: 'connected',
        last_sync_at: tenDaysAgo,
      })
      .execute();

    await engine.runAll(fixture.orgAId);

    const active = await engine.active(fixture.orgAId);
    const stale = active.find((i) => i.title.includes('has not synced'));
    // Connected-but-silent is the dangerous state: the UI looks healthy while
    // the data quietly goes stale.
    expect(stale).toBeDefined();
    expect(stale?.title).toContain('Google Search Console');
  });

  it('does not flag a recently synced integration', async () => {
    await serviceDb()
      .insertInto('capere.integrations')
      .values({
        organization_id: fixture.orgBId,
        provider: 'go_high_level',
        status: 'connected',
        last_sync_at: new Date(),
      })
      .execute();

    expect(await engine.runAll(fixture.orgBId)).toBe(0);
  });

  it('keeps insights isolated between organizations', async () => {
    const orgA = await engine.active(fixture.orgAId);
    const orgB = await engine.active(fixture.orgBId);

    expect(orgA.length).toBeGreaterThan(0);
    expect(orgB).toHaveLength(0);
  });

  it('dismissing an insight removes it from the active set', async () => {
    const before = await engine.active(fixture.orgAId);
    await engine.dismiss(fixture.orgAId, before[0].id);

    const after = await engine.active(fixture.orgAId);
    expect(after.map((i) => i.id)).not.toContain(before[0].id);
  });

  it('respects the feature flag', async () => {
    const flags = new FeatureFlagService(database);
    await flags.setOverride(fixture.orgAId, 'insights.engine', false);

    // Rebuilt so the engine sees the new flag state rather than a cached value.
    const gated = new InsightsEngine(database, new OutboxService(database), flags, [generator]);

    expect(await gated.runAll(fixture.orgAId)).toBe(0);
    await flags.setOverride(fixture.orgAId, 'insights.engine', true);
  });

  it('reports the event types its generators listen for', () => {
    expect(engine.triggerTypes()).toEqual(
      expect.arrayContaining(['integration.disconnected', 'integration.errored']),
    );
  });

  it('survives a generator that throws', async () => {
    const exploding = {
      name: 'exploding',
      description: 'always fails',
      triggers: [],
      generate: async () => {
        throw new Error('simulated generator failure');
      },
    };

    const mixed = new InsightsEngine(
      database,
      new OutboxService(database),
      new FeatureFlagService(database),
      [exploding, generator],
    );

    // A broken SEO generator must not silence analytics.
    await expect(mixed.runAll(fixture.orgAId)).resolves.toBeGreaterThanOrEqual(0);
  });

  it('cleans up its own fixtures', async () => {
    await sql`DELETE FROM capere.insights WHERE organization_id = ${fixture.orgAId}::uuid`.execute(
      serviceDb(),
    );
    await sql`DELETE FROM capere.integrations WHERE organization_id IN (${fixture.orgAId}::uuid, ${fixture.orgBId}::uuid)`.execute(
      serviceDb(),
    );
  });
});
