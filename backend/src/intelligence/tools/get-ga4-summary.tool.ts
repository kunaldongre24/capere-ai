import { Injectable, OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../../shared/database';
import type { Tool, ToolContext } from './tool.interface';
import { ToolRegistry } from './tool-registry';

const inputSchema = z.object({
  property: z
    .string()
    .max(512)
    .optional()
    .describe(
      'GA4 property ID or display name. Omit when only one property is connected.',
    ),
  days: z
    .number()
    .int()
    .min(1)
    .max(90)
    .default(7)
    .describe('Number of recent complete days to summarize.'),
});

type Input = { days?: number; property?: string };

export interface Ga4Summary {
  readonly connected: boolean;
  readonly dataAvailable: boolean;
  readonly resourceId?: string;
  readonly lastSyncedAt?: string;
  readonly latestAvailableDate?: string;
  readonly syncCoverage?: {
    periodStart: string;
    periodEnd: string;
    rowCount: number;
    providerCompletedAt: string;
  };
  readonly period?: { start: string; end: string; days: number };
  readonly metrics?: {
    sessions: number;
    activeUsers: number;
    conversions: number;
    revenue: number;
  };
  readonly previousPeriod?: {
    sessions: number;
    activeUsers: number;
    conversions: number;
    revenue: number;
  };
  readonly changePercent?: Partial<Record<keyof Ga4Summary['metrics'], number | null>>;
  readonly availableResources?: Array<{ resourceId: string; name?: string }>;
  readonly message?: string;
}

@Injectable()
export class GetGa4SummaryTool implements Tool<Input, Ga4Summary>, OnModuleInit {
  readonly name = 'get_ga4_summary';
  readonly description =
    'Returns grounded Google Analytics 4 sessions, active users, conversions, and revenue for a recent period, with the preceding period for comparison. Use it for website traffic or conversion questions.';
  readonly schema = inputSchema;
  readonly permissions = [
    'owner',
    'office_manager',
    'marketing_manager',
    'seo_specialist',
    'capere_admin',
  ] as const;
  readonly agents = ['general', 'analytics', 'cmo', 'seo', 'content'] as const;
  readonly timeoutMs = 10_000;
  readonly mutates = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly registry: ToolRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async execute(input: Input, context: ToolContext): Promise<Ga4Summary> {
    const days = input.days ?? 7;
    const integrations = await this.database.db
      .selectFrom('capere.integrations')
      .select(['id', 'account_id', 'account_name', 'last_sync_at'])
      .where('organization_id', '=', context.organizationId)
      .where('provider', '=', 'google_analytics_4')
      .where('status', '=', 'connected')
      .where('sync_enabled', '=', true)
      .orderBy('last_sync_at', 'desc')
      .execute();
    if (integrations.length === 0)
      return {
        connected: false,
        dataAvailable: false,
        message: 'Google Analytics 4 is not connected for this organization.',
      };

    const selector = input.property?.trim();
    const genericAlias = selector
      ? ['ga4', 'google_analytics_4', 'google analytics 4', 'google analytics'].includes(
          selector.toLowerCase(),
        )
      : false;
    const requested = selector && !genericAlias
      ? integrations.find(
          (row) =>
            row.account_id === selector ||
            row.account_name?.toLowerCase() === selector.toLowerCase(),
        )
      : undefined;
    const integration = requested ??
      ((!selector || genericAlias) && integrations.length === 1 ? integrations[0] : undefined);
    if (!integration)
      return {
        connected: true,
        dataAvailable: false,
        message: selector && !genericAlias
          ? `The requested GA4 property ${selector} is not connected. Choose an available property.`
          : 'Multiple GA4 properties are connected. Choose a property by ID or display name.',
        availableResources: integrations
          .filter((row) => row.account_id)
          .map((row) => ({
            resourceId: row.account_id as string,
            ...(row.account_name ? { name: row.account_name } : {}),
          })),
      };

    const [latest, syncState] = await Promise.all([
      this.database.db
      .selectFrom('capere.analytics_daily')
      .select('metric_date')
      .where('organization_id', '=', context.organizationId)
      .where('integration_id', '=', integration.id)
      .where('provider', '=', 'google_analytics_4')
      .orderBy('metric_date', 'desc')
      .executeTakeFirst(),
      this.database.db
        .selectFrom('capere.integration_sync_states')
        .select(['cursor', 'last_succeeded_at'])
        .where('organization_id', '=', context.organizationId)
        .where('integration_id', '=', integration.id)
        .where('dataset', '=', 'ga4_daily')
        .executeTakeFirst(),
    ]);
    const coverage = this.coverage(syncState?.cursor);
    const lastSyncedAt = syncState?.last_succeeded_at
      ? new Date(syncState.last_succeeded_at).toISOString()
      : integration.last_sync_at
        ? new Date(integration.last_sync_at).toISOString()
        : undefined;
    const currentEnd = this.shift(this.utcToday(), -1);
    const currentStart = this.shift(currentEnd, -(days - 1));
    const requestedPeriod = { start: this.format(currentStart), end: this.format(currentEnd), days };
    if (!latest)
      return {
        connected: true,
        dataAvailable: false,
        resourceId: integration.account_id ?? undefined,
        period: requestedPeriod,
        ...(lastSyncedAt ? { lastSyncedAt } : {}),
        ...(coverage ? { syncCoverage: coverage } : {}),
        message: lastSyncedAt
          ? `The latest Google Analytics 4 sync completed, but no daily metrics are available for the requested period ${requestedPeriod.start} through ${requestedPeriod.end}.`
          : 'Google Analytics 4 is connected, but its first daily metrics sync has not completed yet.',
      };

    const latestDate = this.dateString(latest.metric_date);
    // The previous window is the `days` immediately before the current one, so
    // it ends the day before currentStart. Shifting currentStart back by `days`
    // lands on that start directly — same arithmetic as the GSC tool, kept
    // identical so the two comparison windows cannot silently diverge.
    const previousStart = this.shift(currentStart, -days);
    const rows = await this.database.db
      .selectFrom('capere.analytics_daily')
      .select(['metric_date', 'metrics'])
      .where('organization_id', '=', context.organizationId)
      .where('integration_id', '=', integration.id)
      .where('provider', '=', 'google_analytics_4')
      .where('metric_date', '>=', this.format(previousStart))
      .where('metric_date', '<=', this.format(currentEnd))
      .execute();
    const current = this.empty();
    const previous = this.empty();
    let currentRowCount = 0;
    for (const row of rows) {
      const isCurrent = this.dateString(row.metric_date) >= this.format(currentStart);
      const target = isCurrent ? current : previous;
      if (isCurrent) currentRowCount += 1;
      const metrics = this.object(row.metrics);
      target.sessions += Number(metrics['sessions'] ?? 0);
      target.activeUsers += Number(metrics['activeUsers'] ?? 0);
      target.conversions += Number(metrics['conversions'] ?? 0);
      target.revenue += Number(metrics['revenue'] ?? 0);
    }
    if (currentRowCount === 0)
      return {
        connected: true,
        dataAvailable: false,
        resourceId: integration.account_id ?? undefined,
        period: requestedPeriod,
        lastSyncedAt,
        latestAvailableDate: latestDate,
        ...(coverage ? { syncCoverage: coverage } : {}),
        message: `No Google Analytics 4 metrics are available for the requested period ${requestedPeriod.start} through ${requestedPeriod.end}. The latest stored metric is from ${latestDate}; current performance cannot be inferred from stale data.`,
      };
    return {
      connected: true,
      dataAvailable: true,
      resourceId: integration.account_id ?? undefined,
      period: requestedPeriod,
      lastSyncedAt,
      latestAvailableDate: latestDate,
      ...(coverage ? { syncCoverage: coverage } : {}),
      metrics: current,
      previousPeriod: previous,
      changePercent: {
        sessions: this.change(current.sessions, previous.sessions),
        activeUsers: this.change(current.activeUsers, previous.activeUsers),
        conversions: this.change(current.conversions, previous.conversions),
        revenue: this.change(current.revenue, previous.revenue),
      },
    };
  }

  private empty() {
    return { sessions: 0, activeUsers: 0, conversions: 0, revenue: 0 };
  }
  private object(value: unknown): Record<string, unknown> {
    if (typeof value === 'string') {
      try {
        return JSON.parse(value) as Record<string, unknown>;
      } catch {
        return {};
      }
    }
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  }
  private change(current: number, previous: number): number | null {
    return previous === 0 ? null : Math.round(((current - previous) / previous) * 10_000) / 100;
  }
  private dateString(value: unknown): string {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return String(value).slice(0, 10);
  }
  private utcToday(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
  private coverage(value: unknown): Ga4Summary['syncCoverage'] | undefined {
    const parsed = this.object(value);
    return typeof parsed['periodStart'] === 'string' &&
      typeof parsed['periodEnd'] === 'string' &&
      typeof parsed['rowCount'] === 'number' &&
      typeof parsed['providerCompletedAt'] === 'string'
      ? {
          periodStart: parsed['periodStart'],
          periodEnd: parsed['periodEnd'],
          rowCount: parsed['rowCount'],
          providerCompletedAt: parsed['providerCompletedAt'],
        }
      : undefined;
  }
  private shift(value: Date, days: number): Date {
    return new Date(value.getTime() + days * 86_400_000);
  }
  private format(value: Date): string {
    return value.toISOString().slice(0, 10);
  }
}
