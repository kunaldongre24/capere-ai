import { Injectable, OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../../shared/database';
import type { Tool, ToolContext } from './tool.interface';
import { ToolRegistry } from './tool-registry';

const inputSchema = z.object({
  days: z.number().int().min(1).max(90).default(7),
  integrationId: z.string().uuid().optional(),
});
type Input = { days?: number; integrationId?: string };
export interface GscSummary {
  readonly connected: boolean;
  readonly dataAvailable: boolean;
  readonly integrationId?: string;
  readonly resourceId?: string;
  readonly period?: { start: string; end: string; days: number };
  readonly metrics?: { clicks: number; impressions: number; ctr: number; averagePosition: number };
  readonly previousPeriod?: {
    clicks: number;
    impressions: number;
    ctr: number;
    averagePosition: number;
  };
  readonly message?: string;
}
interface GscAccumulator {
  clicks: number;
  impressions: number;
  positionImpressions: number;
}

@Injectable()
export class GetGscSummaryTool implements Tool<Input, GscSummary>, OnModuleInit {
  readonly name = 'get_gsc_summary';
  readonly description =
    'Returns Google Search Console clicks, impressions, CTR, and average position for a recent period and the preceding period.';
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
  ) {}
  onModuleInit(): void {
    this.registry.register(this);
  }
  async execute(input: Input, context: ToolContext): Promise<GscSummary> {
    const days = input.days ?? 7;
    let integrationQuery = this.database.db
      .selectFrom('capere.integrations')
      .select(['id', 'account_id'])
      .where('organization_id', '=', context.organizationId)
      .where('provider', '=', 'google_search_console')
      .where('status', '=', 'connected')
      .where('sync_enabled', '=', true);
    if (input.integrationId)
      integrationQuery = integrationQuery.where('id', '=', input.integrationId);
    const integration = await integrationQuery.orderBy('last_sync_at', 'desc').executeTakeFirst();
    if (!integration)
      return {
        connected: false,
        dataAvailable: false,
        message: 'Google Search Console is not connected for this organization.',
      };
    const latest = await this.database.db
      .selectFrom('capere.analytics_daily')
      .select('metric_date')
      .where('organization_id', '=', context.organizationId)
      .where('integration_id', '=', integration.id)
      .where('provider', '=', 'google_search_console')
      .where('dimensions', '=', JSON.stringify({}))
      .orderBy('metric_date', 'desc')
      .executeTakeFirst();
    if (!latest)
      return {
        connected: true,
        dataAvailable: false,
        message: 'Google Search Console is connected but has not synced daily metrics yet.',
      };
    const end = this.date(latest.metric_date);
    const currentStart = this.shift(end, -(days - 1));
    const previousStart = this.shift(currentStart, -days);
    const rows = await this.database.db
      .selectFrom('capere.analytics_daily')
      .select(['metric_date', 'metrics'])
      .where('organization_id', '=', context.organizationId)
      .where('integration_id', '=', integration.id)
      .where('provider', '=', 'google_search_console')
      .where('dimensions', '=', JSON.stringify({}))
      .where('metric_date', '>=', previousStart)
      .where('metric_date', '<=', end)
      .execute();
    const current = this.empty();
    const previous = this.empty();
    for (const row of rows) {
      const target = this.date(row.metric_date) >= currentStart ? current : previous;
      const metrics = this.object(row.metrics);
      const impressions = Number(metrics.impressions ?? 0);
      target.clicks += Number(metrics.clicks ?? 0);
      target.impressions += impressions;
      target.positionImpressions +=
        Number(metrics.position ?? metrics.averagePosition ?? 0) * impressions;
    }
    return {
      connected: true,
      dataAvailable: true,
      integrationId: integration.id,
      resourceId: integration.account_id ?? undefined,
      period: { start: currentStart, end, days },
      metrics: this.finish(current),
      previousPeriod: this.finish(previous),
    };
  }
  private empty(): GscAccumulator {
    return { clicks: 0, impressions: 0, positionImpressions: 0 };
  }
  private finish(value: GscAccumulator) {
    return {
      clicks: value.clicks,
      impressions: value.impressions,
      ctr: value.impressions ? value.clicks / value.impressions : 0,
      averagePosition: value.impressions ? value.positionImpressions / value.impressions : 0,
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
