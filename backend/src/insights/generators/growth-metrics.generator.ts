import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../shared/database';
import { EventType, type DomainEvent, type EventTypeValue } from '../../shared/events';
import type { InsightDraft, InsightGenerator } from '../insight.interface';

@Injectable()
export class GrowthMetricsGenerator implements InsightGenerator {
  readonly name = 'growth_metrics';
  readonly description =
    'Detects material changes in traffic, search visibility, and GBP engagement.';
  readonly triggers: readonly EventTypeValue[] = [
    EventType.Ga4Synced,
    EventType.GscSynced,
    EventType.GbpSynced,
  ];
  constructor(private readonly database: DatabaseService) {}

  async generate(organizationId: string, event?: DomainEvent): Promise<InsightDraft[]> {
    const provider = this.provider(event?.type);
    if (!provider) return [];
    const eventPayload = this.object(event?.payload);
    const integrationId = eventPayload['integrationId'];
    let query = this.database.db
      .selectFrom('capere.analytics_daily')
      .select(['metric_date', 'metrics', 'resource_id'])
      .where('organization_id', '=', organizationId)
      .where('provider', '=', provider)
      .where(
        'metric_date',
        '>=',
        new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10),
      );
    if (typeof integrationId === 'string')
      query = query.where('integration_id', '=', integrationId);
    // GSC stores daily totals plus query/page grains in the same normalized
    // table. Only the empty-dimension daily row is additive; summing all grains
    // counts the same clicks up to three times.
    if (provider === 'google_search_console')
      query = query.where('dimensions', '=', JSON.stringify({}));
    const rows = await query.execute();
    const resource = rows[0]?.resource_id;
    if (!resource) return [];
    const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    const key =
      provider === 'google_analytics_4'
        ? 'sessions'
        : provider === 'google_search_console'
          ? 'clicks'
          : 'WEBSITE_CLICKS';
    let current = 0,
      previous = 0;
    for (const row of rows) {
      const metrics = this.object(row.metrics);
      const value = Number(metrics[key] ?? 0);
      if (row.metric_date >= cutoff) current += value;
      else previous += value;
    }
    if (previous <= 0) return [];
    const change = (current - previous) / previous;
    if (Math.abs(change) < 0.2) return [];
    const label =
      provider === 'google_analytics_4'
        ? 'website sessions'
        : provider === 'google_search_console'
          ? 'organic clicks'
          : 'GBP website actions';
    return [
      {
        category:
          provider === 'google_business_profile'
            ? 'gbp'
            : provider === 'google_search_console'
              ? 'seo'
              : 'analytics',
        severity: change <= -0.4 ? 'high' : change < 0 ? 'medium' : 'info',
        title: `${label} ${change < 0 ? 'fell' : 'increased'} ${Math.abs(Math.round(change * 100))}% week over week`,
        body: `The latest seven-day period recorded ${Math.round(current)} ${label}, compared with ${Math.round(previous)} in the preceding period.`,
        dedupeKey: `growth_metric:${provider}:${resource}:${key}:${change < 0 ? 'down' : 'up'}`,
        payload: { provider, resourceId: resource, metric: key, current, previous, change },
        confidence: 0.9,
      },
    ];
  }
  private provider(type?: string) {
    if (type === EventType.Ga4Synced) return 'google_analytics_4' as const;
    if (type === EventType.GscSynced) return 'google_search_console' as const;
    if (type === EventType.GbpSynced) return 'google_business_profile' as const;
    return undefined;
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
}
