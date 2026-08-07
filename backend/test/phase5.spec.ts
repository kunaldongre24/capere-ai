import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RecommendationService } from '../src/recommendations/recommendation.service';
import { DashboardService } from '../src/reporting/dashboard.service';
import { OutboxService } from '../src/shared/events';
import type { DatabaseService } from '../src/shared/database';
import {
  cleanup,
  closeDb,
  seedTwoOrganizations,
  serviceDb,
  type Fixture,
} from './helpers/database';

function database(): DatabaseService {
  return {
    db: serviceDb(),
    transaction: <T>(fn: (trx: unknown) => Promise<T>) =>
      serviceDb()
        .transaction()
        .execute((trx) => fn(trx)),
  } as unknown as DatabaseService;
}

describe('Phase 5 recommendations and dashboard marts', () => {
  let fixture: Fixture;
  let recommendations: RecommendationService;
  let dashboards: DashboardService;

  beforeAll(async () => {
    fixture = await seedTwoOrganizations();
    const db = database();
    recommendations = new RecommendationService(db, new OutboxService(db));
    dashboards = new DashboardService(db);
    const insight = await serviceDb()
      .insertInto('capere.insights')
      .values({
        organization_id: fixture.orgAId,
        category: 'seo',
        severity: 'high',
        source_generator: 'phase5-test',
        dedupe_key: `phase5:${fixture.orgAId}`,
        title: 'Ranking opportunity',
        body: 'A keyword needs attention.',
        payload: JSON.stringify({ keyword: 'accountant near me', rank: 16 }),
        confidence: '0.90',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    expect(insight.id).toBeTruthy();
    await serviceDb()
      .insertInto('capere.analytics_daily')
      .values({
        organization_id: fixture.orgAId,
        integration_id: await serviceDb()
          .insertInto('capere.integrations')
          .values({
            organization_id: fixture.orgAId,
            provider: 'google_analytics_4',
            status: 'connected',
          })
          .returning('id')
          .executeTakeFirstOrThrow()
          .then((row) => row.id),
        provider: 'google_analytics_4',
        resource_id: 'phase5',
        metric_date: '2026-08-04',
        metrics: JSON.stringify({ sessions: 100, conversions: 5, revenue: 2500 }),
      })
      .execute();
  });

  afterAll(async () => {
    await cleanup(fixture);
    await closeDb();
  });

  it('generates a deduplicated recommendation and records its lifecycle', async () => {
    expect(await recommendations.generateFromInsights(fixture.orgAId)).toBe(1);
    expect(await recommendations.generateFromInsights(fixture.orgAId)).toBe(0);
    const rows = await recommendations.list(fixture.orgAId);
    expect(rows).toHaveLength(1);
    expect(rows[0].priority).toBe('high');
    await recommendations.transition(
      fixture.orgAId,
      rows[0].id,
      'approved',
      fixture.userAId,
      'Owner approved',
    );
    await recommendations.transition(fixture.orgAId, rows[0].id, 'in_progress', fixture.userAId);
    await recommendations.transition(fixture.orgAId, rows[0].id, 'completed', fixture.userAId);
    expect(
      (await recommendations.history(fixture.orgAId, rows[0].id)).map((row) => row.to_status),
    ).toEqual(['completed', 'in_progress', 'approved', 'proposed']);
  });

  it('precomputes long-form dashboard metrics and keeps tenants separate', async () => {
    const secondIntegration = await serviceDb()
      .insertInto('capere.integrations')
      .values({
        organization_id: fixture.orgAId,
        provider: 'google_analytics_4',
        account_id: `second-${crypto.randomUUID()}`,
        status: 'connected',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await serviceDb()
      .insertInto('capere.analytics_daily')
      .values({
        organization_id: fixture.orgAId,
        integration_id: secondIntegration.id,
        provider: 'google_analytics_4',
        resource_id: 'phase5-second',
        metric_date: '2026-08-04',
        metrics: JSON.stringify({ sessions: 50 }),
      })
      .execute();
    expect(await dashboards.refresh(fixture.orgAId)).toBeGreaterThan(0);
    const rows = await dashboards.query(fixture.orgAId, 'executive', 30);
    expect(rows.some((row) => row.metric_name === 'sessions' && row.metric_value === '100')).toBe(
      true,
    );
    expect(rows.filter((row) => row.metric_name === 'sessions')).toHaveLength(2);
    expect(await dashboards.query(fixture.orgBId, 'executive', 30)).toHaveLength(0);
  });

  it('generates a persisted weekly report from precomputed evidence', async () => {
    const report = await dashboards.generateExecutiveReport(
      fixture.orgAId,
      new Date('2026-08-04T00:00:00Z'),
    );
    expect(report.title).toContain('2026-08-04');
    expect(report.content).toContain('Observed metrics:');
    expect(await dashboards.latestReport(fixture.orgAId)).toMatchObject({ id: report.id });
    expect((await dashboards.cmoBrief(fixture.orgAId)).evidenceComplete).toBe(true);
    expect((await dashboards.seoCommandCenter(fixture.orgAId)).evidenceComplete).toBe(true);
  });
});
