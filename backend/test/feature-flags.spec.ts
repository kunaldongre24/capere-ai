import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FeatureFlagService } from '../src/feature-flags/feature-flag.service';
import { FeatureFlag, FEATURE_FLAG_DEFINITIONS } from '../src/feature-flags/feature-flag.catalog';
import type { DatabaseService } from '../src/shared/database';
import {
  cleanup,
  closeDb,
  seedTwoOrganizations,
  serviceDb,
  type Fixture,
} from './helpers/database';

/**
 * Feature flags against a real database.
 *
 * The behaviour that matters: an override is scoped to ONE organization. A flag
 * turned on for a beta customer must not leak to anyone else — that is the whole
 * point of per-org rollout.
 */
describe('FeatureFlagService', () => {
  let fixture: Fixture;
  let flags: FeatureFlagService;

  beforeAll(async () => {
    fixture = await seedTwoOrganizations();
    // The service only needs `db` and `transaction`; a structural stand-in keeps
    // this a focused integration test rather than booting the whole Nest app.
    const database = {
      db: serviceDb(),
      transaction: <T>(fn: (trx: unknown) => Promise<T>) =>
        serviceDb()
          .transaction()
          .execute((trx) => fn(trx)),
    } as unknown as DatabaseService;
    flags = new FeatureFlagService(database);
  });

  afterAll(async () => {
    await cleanup(fixture);
    await closeDb();
  });

  it('falls back to the catalog default when no override exists', async () => {
    // SemanticMemory is deliberately default-off: its Phase 1 implementation is
    // a null adapter, so enabling it would silently return no context.
    await expect(flags.isEnabled(fixture.orgAId, FeatureFlag.SemanticMemory)).resolves.toBe(false);
    await expect(flags.isEnabled(fixture.orgAId, FeatureFlag.HermesPlanner)).resolves.toBe(true);
  });

  it('applies an organization override over the default', async () => {
    await flags.setOverride(fixture.orgAId, FeatureFlag.SemanticMemory, true, {
      reason: 'beta customer',
    });

    await expect(flags.isEnabled(fixture.orgAId, FeatureFlag.SemanticMemory)).resolves.toBe(true);
  });

  it('does not leak an override to another organization', async () => {
    await flags.setOverride(fixture.orgAId, FeatureFlag.ChatStreaming, false, {
      reason: 'incident',
    });

    // Org A opted out; org B must be unaffected.
    await expect(flags.isEnabled(fixture.orgAId, FeatureFlag.ChatStreaming)).resolves.toBe(false);
    await expect(flags.isEnabled(fixture.orgBId, FeatureFlag.ChatStreaming)).resolves.toBe(true);
  });

  it('takes effect immediately, without waiting out the cache TTL', async () => {
    await flags.setOverride(fixture.orgBId, FeatureFlag.InsightsEngine, false);
    await expect(flags.isEnabled(fixture.orgBId, FeatureFlag.InsightsEngine)).resolves.toBe(false);

    // An emergency toggle that took 60s to apply would be useless.
    await flags.setOverride(fixture.orgBId, FeatureFlag.InsightsEngine, true);
    await expect(flags.isEnabled(fixture.orgBId, FeatureFlag.InsightsEngine)).resolves.toBe(true);
  });

  it('is idempotent when the same override is set twice', async () => {
    await flags.setOverride(fixture.orgAId, FeatureFlag.HermesReflection, false);
    await flags.setOverride(fixture.orgAId, FeatureFlag.HermesReflection, false);

    const rows = await serviceDb()
      .selectFrom('capere.organization_feature_flags as off')
      .innerJoin('capere.feature_flags as f', 'f.id', 'off.flag_id')
      .select('off.id')
      .where('off.organization_id', '=', fixture.orgAId)
      .where('f.key', '=', FeatureFlag.HermesReflection)
      .execute();

    // ON CONFLICT DO UPDATE, not a second row.
    expect(rows).toHaveLength(1);
  });

  it('reports every catalog flag for an organization', async () => {
    const all = await flags.allFor(fixture.orgAId);
    expect(all).toHaveLength(FEATURE_FLAG_DEFINITIONS.length);
    expect(all.every((f) => typeof f.enabled === 'boolean')).toBe(true);
  });

  it('rejects an undeclared flag rather than silently defaulting', async () => {
    // A typo'd flag key must fail loudly: silently returning false would make a
    // feature invisibly dead in production.
    await expect(flags.isEnabled(fixture.orgAId, 'nonexistent.flag' as never)).rejects.toThrow(
      /Unknown feature flag/,
    );
  });
});
