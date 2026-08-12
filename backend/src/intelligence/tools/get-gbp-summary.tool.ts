import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../../shared/database';
import type { Tool, ToolContext } from './tool.interface';
import { ToolRegistry } from './tool-registry';
import { GhlReputationService } from '../../integrations/ghl/ghl-reputation.service';
const inputSchema = z.object({
  days: z.number().int().min(1).max(90).default(7),
  integrationId: z.string().uuid().optional(),
});
type Input = { days?: number; integrationId?: string };
export interface GbpSummary {
  readonly connected: boolean;
  readonly dataAvailable: boolean;
  readonly source?: 'go_high_level' | 'direct_google';
  readonly accessStatus?: 'available' | 'permission_required' | 'temporarily_unavailable';
  readonly profileConnectionConfirmed?: boolean;
  readonly coverage?: {
    reviews: boolean;
    mapsPerformance: boolean;
    postsPhotosQa: boolean;
  };
  readonly integrationId?: string;
  readonly resourceId?: string;
  readonly period?: { start: string; end: string; days: number };
  readonly metrics?: Record<string, number>;
  readonly reviews?: { count: number; averageRating: number; unanswered: number };
  readonly message?: string;
}
@Injectable()
export class GetGbpSummaryTool implements Tool<Input, GbpSummary>, OnModuleInit {
  readonly name = 'get_gbp_summary';
  readonly description =
    'Checks local-profile and Google Business Profile data. Always use this tool for questions mentioning GBP, Google Business Profile, Google reviews, ratings, review replies, reputation, or local profile. Review data is normally supplied through GoHighLevel; direct Google authorization is only needed for Maps/Search performance metrics such as impressions, calls, website clicks, and directions.';
  readonly schema = inputSchema;
  readonly permissions = [
    'owner',
    'office_manager',
    'marketing_manager',
    'seo_specialist',
    'capere_admin',
  ] as const;
  readonly agents = ['general', 'seo', 'analytics', 'cmo', 'content'] as const;
  readonly timeoutMs = 10_000;
  readonly mutates = false;
  constructor(
    private readonly database: DatabaseService,
    private readonly registry: ToolRegistry,
    @Optional() private readonly ghlReputation?: GhlReputationService,
  ) {}
  onModuleInit(): void {
    this.registry.register(this);
  }
  async execute(input: Input, context: ToolContext): Promise<GbpSummary> {
    const days = input.days ?? 7;
    const ghl = await this.ghlReputation?.summary(context.organizationId);
    if (ghl?.connected)
      return {
        connected: true,
        dataAvailable: ghl.dataAvailable,
        source: 'go_high_level',
        accessStatus: ghl.accessStatus,
        profileConnectionConfirmed: ghl.profileConnectionConfirmed,
        coverage: {
          reviews: ghl.accessStatus === 'available',
          mapsPerformance: false,
          postsPhotosQa: false,
        },
        resourceId: ghl.locationId,
        reviews: {
          count: ghl.reviewCount,
          averageRating: ghl.averageRating,
          unanswered: ghl.unanswered,
        },
        message: ghl.message,
      };
    let integrationQuery = this.database.db
      .selectFrom('capere.integrations')
      .select(['id', 'account_id'])
      .where('organization_id', '=', context.organizationId)
      .where('provider', '=', 'google_business_profile')
      .where('status', '=', 'connected')
      .where('sync_enabled', '=', true);
    if (input.integrationId)
      integrationQuery = integrationQuery.where('id', '=', input.integrationId);
    const integration = await integrationQuery.orderBy('last_sync_at', 'desc').executeTakeFirst();
    if (!integration)
      return {
        connected: false,
        dataAvailable: false,
        message: 'Google Business Profile is not connected for this organization.',
      };
    const latest = await this.database.db
      .selectFrom('capere.analytics_daily')
      .select('metric_date')
      .where('organization_id', '=', context.organizationId)
      .where('integration_id', '=', integration.id)
      .where('provider', '=', 'google_business_profile')
      .orderBy('metric_date', 'desc')
      .executeTakeFirst();
    const reviews = await this.database.db
      .selectFrom('capere.gbp_reviews')
      .select(['rating', 'reply'])
      .where('organization_id', '=', context.organizationId)
      .where('integration_id', '=', integration.id)
      .execute();
    if (!latest)
      return {
        connected: true,
        dataAvailable: reviews.length > 0,
        reviews: {
          count: reviews.length,
          averageRating: reviews.length
            ? reviews.reduce((n, r) => n + r.rating, 0) / reviews.length
            : 0,
          unanswered: reviews.filter((r) => !r.reply).length,
        },
        message: reviews.length
          ? undefined
          : 'Google Business Profile is connected but has not synced performance metrics yet.',
      };
    const end = this.date(latest.metric_date);
    const start = this.shift(end, -(days - 1));
    const rows = await this.database.db
      .selectFrom('capere.analytics_daily')
      .select(['metrics'])
      .where('organization_id', '=', context.organizationId)
      .where('integration_id', '=', integration.id)
      .where('provider', '=', 'google_business_profile')
      .where('metric_date', '>=', start)
      .where('metric_date', '<=', end)
      .execute();
    const metrics: Record<string, number> = {};
    for (const row of rows)
      for (const [key, value] of Object.entries(this.object(row.metrics)))
        metrics[key] = (metrics[key] ?? 0) + Number(value ?? 0);
    return {
      connected: true,
      dataAvailable: true,
      source: 'direct_google',
      accessStatus: 'available',
      profileConnectionConfirmed: true,
      coverage: { reviews: true, mapsPerformance: true, postsPhotosQa: false },
      integrationId: integration.id,
      resourceId: integration.account_id ?? undefined,
      period: { start, end, days },
      metrics,
      reviews: {
        count: reviews.length,
        averageRating: reviews.length
          ? reviews.reduce((n, r) => n + r.rating, 0) / reviews.length
          : 0,
        unanswered: reviews.filter((r) => !r.reply).length,
      },
    };
  }
  private object(v: unknown): Record<string, number> {
    return v && typeof v === 'object' ? (v as Record<string, number>) : {};
  }
  private date(v: unknown): string {
    return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
  }
  private shift(value: string, days: number): string {
    const d = new Date(`${value}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }
}
