import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../shared/database';
import { EventType, OutboxService } from '../shared/events';
import type {
  InsightCategory,
  RecommendationPriority,
  RecommendationStatus,
} from '../shared/database';

export interface RecommendationDraft {
  readonly sourceInsightId?: string;
  readonly category: InsightCategory;
  readonly priority: RecommendationPriority;
  readonly dedupeKey: string;
  readonly title: string;
  readonly rationale: string;
  readonly action: string;
  readonly expectedImpact?: string;
  readonly ownerRole?:
    'owner' | 'office_manager' | 'marketing_manager' | 'seo_specialist' | 'capere_admin';
  readonly evidence?: Record<string, unknown>;
  readonly confidence?: number;
  readonly dueAt?: Date;
  readonly expiresAt?: Date;
}

const transitions: Record<RecommendationStatus, readonly RecommendationStatus[]> = {
  proposed: ['approved', 'dismissed', 'expired'],
  approved: ['in_progress', 'dismissed', 'expired'],
  in_progress: ['completed', 'dismissed'],
  completed: [],
  dismissed: [],
  expired: [],
};

@Injectable()
export class RecommendationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly outbox: OutboxService,
  ) {}

  async generateFromInsights(organizationId: string): Promise<number> {
    await this.dismissRecommendationsFromInactiveInsights(organizationId);
    const insights = await this.database.db
      .selectFrom('capere.insights')
      .select([
        'id',
        'category',
        'severity',
        'title',
        'body',
        'payload',
        'confidence',
        'expires_at',
      ])
      .where('organization_id', '=', organizationId)
      .where('status', '=', 'active')
      .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', new Date())]))
      .orderBy('created_at', 'desc')
      .limit(100)
      .execute();

    let created = 0;
    for (const insight of insights) {
      const priority = this.priority(insight.severity);
      const row = await this.database.transaction(async (trx) => {
        const existing = await trx
          .selectFrom('capere.recommendations')
          .select('id')
          .where('organization_id', '=', organizationId)
          .where('dedupe_key', '=', `insight:${insight.id}`)
          .executeTakeFirst();
        if (existing) return false;

        const recommendation = await trx
          .insertInto('capere.recommendations')
          .values({
            organization_id: organizationId,
            source_insight_id: insight.id,
            category: insight.category,
            priority,
            dedupe_key: `insight:${insight.id}`,
            title: insight.title,
            rationale: insight.body,
            action: this.actionFor(insight.category),
            expected_impact:
              'Address the observed signal and measure the associated KPI in the next reporting period.',
            owner_role: this.ownerFor(insight.category),
            evidence: JSON.stringify(insight.payload ?? {}),
            confidence: insight.confidence,
            expires_at: insight.expires_at,
          })
          .returning(['id', 'category', 'priority'])
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('capere.recommendation_history')
          .values({
            organization_id: organizationId,
            recommendation_id: recommendation.id,
            from_status: null,
            to_status: 'proposed',
            reason: 'Generated from an active insight',
            snapshot: JSON.stringify({ title: insight.title }),
          })
          .execute();
        await this.outbox.publishInTransaction(trx, {
          type: EventType.RecommendationGenerated,
          organizationId,
          aggregateType: 'recommendation',
          aggregateId: recommendation.id,
          payload: {
            recommendationId: recommendation.id,
            category: recommendation.category,
            priority: recommendation.priority,
          },
        });
        return true;
      });
      if (row) created += 1;
    }
    return created;
  }

  private async dismissRecommendationsFromInactiveInsights(organizationId: string): Promise<void> {
    const stale = await this.database.db
      .selectFrom('capere.recommendations as r')
      .innerJoin('capere.insights as i', (join) =>
        join
          .onRef('i.organization_id', '=', 'r.organization_id')
          .onRef('i.id', '=', 'r.source_insight_id'),
      )
      .select(['r.id', 'r.status', 'r.title'])
      .where('r.organization_id', '=', organizationId)
      .where('r.status', 'in', ['proposed', 'approved'])
      .where((eb) =>
        eb.or([
          eb('i.status', '<>', 'active'),
          eb.and([eb('i.expires_at', 'is not', null), eb('i.expires_at', '<=', new Date())]),
        ]),
      )
      .execute();
    if (stale.length === 0) return;
    await this.database.transaction(async (trx) => {
      for (const row of stale) {
        await trx.updateTable('capere.recommendations').set({ status: 'dismissed' }).where('organization_id', '=', organizationId).where('id', '=', row.id).execute();
        await trx.insertInto('capere.recommendation_history').values({ organization_id: organizationId, recommendation_id: row.id, from_status: row.status, to_status: 'dismissed', reason: 'Source insight is no longer active', snapshot: JSON.stringify({ title: row.title }) }).execute();
      }
    });
  }

  async list(organizationId: string, status?: RecommendationStatus, limit = 50) {
    let query = this.database.db
      .selectFrom('capere.recommendations')
      .selectAll()
      .where('organization_id', '=', organizationId);
    if (status) query = query.where('status', '=', status);
    return query.orderBy('created_at', 'desc').limit(Math.min(limit, 100)).execute();
  }

  async transition(
    organizationId: string,
    recommendationId: string,
    toStatus: RecommendationStatus,
    changedBy?: string,
    reason?: string,
  ) {
    return this.database.transaction(async (trx) => {
      const current = await trx
        .selectFrom('capere.recommendations')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', recommendationId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (!transitions[current.status].includes(toStatus))
        throw new Error(`Invalid recommendation transition ${current.status} -> ${toStatus}`);
      const now = new Date();
      const update = {
        status: toStatus,
        updated_at: now,
        ...(toStatus === 'approved' ? { approved_by: changedBy ?? null, approved_at: now } : {}),
        ...(toStatus === 'completed' ? { completed_at: now } : {}),
      };
      const updated = await trx
        .updateTable('capere.recommendations')
        .set(update)
        .where('organization_id', '=', organizationId)
        .where('id', '=', recommendationId)
        .where('status', '=', current.status)
        .returningAll()
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('capere.recommendation_history')
        .values({
          organization_id: organizationId,
          recommendation_id: recommendationId,
          from_status: current.status,
          to_status: toStatus,
          reason: reason ?? null,
          changed_by: changedBy ?? null,
          snapshot: JSON.stringify({ title: current.title }),
        })
        .execute();
      return updated;
    });
  }

  async history(organizationId: string, recommendationId: string) {
    return this.database.db
      .selectFrom('capere.recommendation_history')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('recommendation_id', '=', recommendationId)
      .orderBy('created_at', 'desc')
      .execute();
  }

  private priority(severity: string): RecommendationPriority {
    if (severity === 'critical' || severity === 'high') return severity;
    if (severity === 'medium') return 'medium';
    return 'low';
  }

  private ownerFor(category: InsightCategory) {
    return category === 'seo'
      ? 'seo_specialist'
      : category === 'marketing'
        ? 'marketing_manager'
        : 'owner';
  }

  private actionFor(category: InsightCategory): string {
    const actions: Record<InsightCategory, string> = {
      analytics:
        'Review the affected KPI, confirm the reporting window, and assign an owner to investigate the change.',
      seo: 'Review the affected rankings or technical findings and schedule the highest-impact remediation.',
      gbp: 'Review the Business Profile finding and complete the recommended profile, review, or post action.',
      revenue:
        'Review the linked pipeline evidence in GoHighLevel and assign a measurable revenue follow-up.',
      operations: 'Confirm the operational issue and assign a corrective task with a due date.',
      marketing:
        'Convert the finding into a campaign action and define the KPI that will determine success.',
    };
    return actions[category];
  }
}
