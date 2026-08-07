import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService, type IntegrationProvider } from '../../shared/database';
import { EventType, OutboxService } from '../../shared/events';
import { AppException, ErrorCode } from '../../shared/http';
import { GoogleAdapter } from './google.adapter';
import { GoogleTokenService } from './google-token.service';

export function normalizeGa4PropertyName(value: string): string {
  const match = /^(?:properties\/)?(\d+)$/.exec(value);
  if (!match) {
    throw AppException.badRequest(
      ErrorCode.INTEGRATION_ERROR,
      'GA4 property identifier is invalid',
    );
  }
  return `properties/${match[1]}`;
}

const DAY_MS = 86_400_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function resolveSyncDateRange(
  from?: string,
  to?: string,
  now = new Date(),
): { start: string; end: string } {
  const yesterday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - DAY_MS,
  );
  const end = to ?? yesterday.toISOString().slice(0, 10);
  const parsedEnd = parseDateOnly(end);
  const start = from ?? new Date(parsedEnd.getTime() - 6 * DAY_MS).toISOString().slice(0, 10);
  const parsedStart = parseDateOnly(start);
  if (parsedStart > parsedEnd) {
    throw AppException.badRequest(
      ErrorCode.INTEGRATION_ERROR,
      'Google sync start date must not be after the end date',
    );
  }
  return { start, end };
}

function parseDateOnly(value: string): Date {
  if (!DATE_PATTERN.test(value)) {
    throw AppException.badRequest(
      ErrorCode.INTEGRATION_ERROR,
      'Google sync dates must use YYYY-MM-DD format',
    );
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw AppException.badRequest(ErrorCode.INTEGRATION_ERROR, 'Google sync date is invalid');
  }
  return parsed;
}

interface IntegrationRow {
  id: string;
  organization_id: string;
  provider: IntegrationProvider;
  account_id: string | null;
  authorization_id: string | null;
  provider_metadata: unknown;
}

@Injectable()
export class GoogleSyncService {
  constructor(
    private readonly database: DatabaseService,
    private readonly google: GoogleAdapter,
    private readonly tokens: GoogleTokenService,
    private readonly outbox: OutboxService,
  ) {}

  async sync(
    organizationId: string,
    integrationId: string,
    from?: string,
    to?: string,
  ): Promise<{ rows: number }> {
    const integration = (await this.database.db
      .selectFrom('capere.integrations')
      .select([
        'id',
        'organization_id',
        'provider',
        'account_id',
        'authorization_id',
        'provider_metadata',
      ])
      .where('organization_id', '=', organizationId)
      .where('id', '=', integrationId)
      .executeTakeFirst()) as IntegrationRow | undefined;
    if (!integration?.account_id || !integration.authorization_id)
      throw new Error('Google integration is incomplete');
    const { start, end } = resolveSyncDateRange(from, to);
    const token = await this.tokens.accessToken(organizationId, integration.authorization_id);
    if (integration.provider === 'google_analytics_4')
      return this.syncGa4(integration, token, start, end);
    if (integration.provider === 'google_search_console')
      return this.syncGsc(integration, token, start, end);
    if (integration.provider === 'google_business_profile')
      return this.syncGbp(integration, token, start, end);
    throw new Error(`Unsupported Google provider ${integration.provider}`);
  }

  private async syncGa4(i: IntegrationRow, token: string, start: string, end: string) {
    const propertyName = normalizeGa4PropertyName(i.account_id!);
    const body = await this.google.postJson<{
      rows?: Array<{
        dimensionValues?: Array<{ value?: string }>;
        metricValues?: Array<{ value?: string }>;
      }>;
    }>(
      `https://analyticsdata.googleapis.com/v1beta/${propertyName}:runReport`,
      token,
      {
        dateRanges: [{ startDate: start, endDate: end }],
        dimensions: [{ name: 'date' }],
        metrics: [
          { name: 'sessions' },
          { name: 'activeUsers' },
          { name: 'eventCount' },
          { name: 'conversions' },
          { name: 'totalRevenue' },
        ],
        limit: 100000,
      },
    );
    const rows = (body.rows ?? [])
      .map((row) => ({
        date: this.googleDate(row.dimensionValues?.[0]?.value ?? ''),
        values: row.metricValues?.map((v) => Number(v.value ?? 0)) ?? [],
      }))
      .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date));
    await this.persist(
      i,
      'ga4_daily',
      rows.map((r) => ({
        date: r.date,
        dimensions: {},
        metrics: {
          sessions: r.values[0] ?? 0,
          activeUsers: r.values[1] ?? 0,
          eventCount: r.values[2] ?? 0,
          conversions: r.values[3] ?? 0,
          revenue: r.values[4] ?? 0,
        },
      })),
      EventType.Ga4Synced,
      { periodStart: start, periodEnd: end, rowCount: rows.length },
      {
        integrationId: i.id,
        propertyId: i.account_id!,
        periodStart: start,
        periodEnd: end,
        sessions: rows.reduce((n, r) => n + (r.values[0] ?? 0), 0),
        conversions: rows.reduce((n, r) => n + (r.values[3] ?? 0), 0),
      },
    );
    return { rows: rows.length };
  }

  private async syncGsc(i: IntegrationRow, token: string, start: string, end: string) {
    const all: Array<{
      date: string;
      dimensions: Record<string, string>;
      metrics: Record<string, number>;
    }> = [];
    for (const grain of [['date'], ['date', 'query'], ['date', 'page']] as const) {
      let startRow = 0;
      for (;;) {
        const body = await this.google.postJson<{
          rows?: Array<{
            keys?: string[];
            clicks?: number;
            impressions?: number;
            ctr?: number;
            position?: number;
          }>;
        }>(
          `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(i.account_id!)}/searchAnalytics/query`,
          token,
          { startDate: start, endDate: end, dimensions: grain, rowLimit: 25000, startRow },
        );
        const page = body.rows ?? [];
        for (const row of page)
          all.push({
            date: row.keys?.[0] ?? start,
            dimensions: grain.length === 2 ? { [grain[1]]: row.keys?.[1] ?? '' } : {},
            metrics: {
              clicks: row.clicks ?? 0,
              impressions: row.impressions ?? 0,
              ctr: row.ctr ?? 0,
              position: row.position ?? 0,
            },
          });
        if (page.length < 25000) break;
        startRow += page.length;
      }
    }
    const daily = all.filter((r) => Object.keys(r.dimensions).length === 0);
    await this.persist(i, 'gsc_search_analytics', all, EventType.GscSynced, {
      periodStart: start,
      periodEnd: end,
      rowCount: all.length,
    }, {
      integrationId: i.id,
      siteUrl: i.account_id!,
      periodStart: start,
      periodEnd: end,
      clicks: daily.reduce((n, r) => n + r.metrics.clicks, 0),
      impressions: daily.reduce((n, r) => n + r.metrics.impressions, 0),
    });
    return { rows: all.length };
  }

  private async syncGbp(i: IntegrationRow, token: string, start: string, end: string) {
    const url = new URL(
      `https://businessprofileperformance.googleapis.com/v1/${i.account_id}:fetchMultiDailyMetricsTimeSeries`,
    );
    for (const metric of [
      'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
      'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
      'WEBSITE_CLICKS',
      'CALL_CLICKS',
      'BUSINESS_DIRECTION_REQUESTS',
    ])
      url.searchParams.append('dailyMetrics', metric);
    url.searchParams.set('dailyRange.startDate.year', start.slice(0, 4));
    url.searchParams.set('dailyRange.startDate.month', String(Number(start.slice(5, 7))));
    url.searchParams.set('dailyRange.startDate.day', String(Number(start.slice(8, 10))));
    url.searchParams.set('dailyRange.endDate.year', end.slice(0, 4));
    url.searchParams.set('dailyRange.endDate.month', String(Number(end.slice(5, 7))));
    url.searchParams.set('dailyRange.endDate.day', String(Number(end.slice(8, 10))));
    const body = await this.google.getJson<{
      multiDailyMetricTimeSeries?: Array<{
        dailyMetricTimeSeries?: Array<{
          dailyMetric?: string;
          timeSeries?: {
            datedValues?: Array<{
              date?: { year?: number; month?: number; day?: number };
              value?: string;
            }>;
          };
        }>;
      }>;
    }>(url.toString(), token);
    const byDate = new Map<string, Record<string, number>>();
    for (const group of body.multiDailyMetricTimeSeries ?? [])
      for (const series of group.dailyMetricTimeSeries ?? [])
        for (const point of series.timeSeries?.datedValues ?? []) {
          const d = point.date;
          if (!d?.year || !d.month || !d.day) continue;
          const date = `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
          byDate.set(date, {
            ...(byDate.get(date) ?? {}),
            [series.dailyMetric ?? 'unknown']: Number(point.value ?? 0),
          });
        }
    const rows = [...byDate].map(([date, metrics]) => ({ date, dimensions: {}, metrics }));
    const reviewSummary = await this.syncGbpReviews(i, token);
    await this.persist(i, 'gbp_performance', rows, EventType.GbpSynced, {
      periodStart: start,
      periodEnd: end,
      rowCount: rows.length,
    }, {
      integrationId: i.id,
      locationId: i.account_id!,
      reviewCount: reviewSummary.count,
      averageRating: reviewSummary.averageRating,
    });
    return { rows: rows.length };
  }

  private async syncGbpReviews(
    i: IntegrationRow,
    token: string,
  ): Promise<{ count: number; averageRating: number }> {
    const metadata = this.object(i.provider_metadata);
    const parentAccount = metadata['parentAccount'];
    if (typeof parentAccount !== 'string' || !i.account_id) return { count: 0, averageRating: 0 };
    const reviews: Array<{
      name?: string;
      reviewId?: string;
      starRating?: string;
      comment?: string;
      reviewer?: { displayName?: string };
      createTime?: string;
      updateTime?: string;
      reviewReply?: unknown;
    }> = [];
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({ pageSize: '50' });
      if (pageToken) query.set('pageToken', pageToken);
      const body = await this.google.getJson<{
        reviews?: typeof reviews;
        nextPageToken?: string;
      }>(
        `https://mybusiness.googleapis.com/v4/${parentAccount}/${i.account_id}/reviews?${query.toString()}`,
        token,
      );
      reviews.push(...(body.reviews ?? []));
      pageToken = body.nextPageToken;
    } while (pageToken);
    if (reviews.length > 0)
      await this.database.db
        .insertInto('capere.gbp_reviews')
        .values(
          reviews.map((review) => ({
            organization_id: i.organization_id,
            integration_id: i.id,
            location_id: i.account_id!,
            review_id: review.reviewId ?? review.name ?? '',
            rating: this.gbpRating(review.starRating),
            comment: review.comment ?? null,
            reviewer_name: review.reviewer?.displayName ?? null,
            review_created_at: review.createTime ? new Date(review.createTime) : null,
            review_updated_at: review.updateTime ? new Date(review.updateTime) : null,
            reply: review.reviewReply ? JSON.stringify(review.reviewReply) : null,
          })),
        )
        .onConflict((c) =>
          c.columns(['organization_id', 'location_id', 'review_id']).doUpdateSet((eb) => ({
            rating: eb.ref('excluded.rating'),
            comment: eb.ref('excluded.comment'),
            reviewer_name: eb.ref('excluded.reviewer_name'),
            review_updated_at: eb.ref('excluded.review_updated_at'),
            reply: eb.ref('excluded.reply'),
          })),
        )
        .execute();
    const ratings = reviews.map((review) => this.gbpRating(review.starRating));
    return {
      count: reviews.length,
      averageRating: ratings.length
        ? ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length
        : 0,
    };
  }

  private gbpRating(value?: string): number {
    const ratings: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
    return ratings[value ?? ''] ?? 1;
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

  private async persist<
    T extends typeof EventType.Ga4Synced | typeof EventType.GscSynced | typeof EventType.GbpSynced,
  >(
    i: IntegrationRow,
    dataset: string,
    rows: Array<{
      date: string;
      dimensions: Record<string, string>;
      metrics: Record<string, number>;
    }>,
    eventType: T,
    coverage: { periodStart: string; periodEnd: string; rowCount: number },
    payload: Parameters<OutboxService['publishInTransaction']>[1]['payload'],
  ) {
    await this.database.transaction(async (trx) => {
      const completedAt = new Date();
      const cursor = JSON.stringify({ ...coverage, providerCompletedAt: completedAt.toISOString() });
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`sync:${i.id}:${dataset}`}, 0))`.execute(
        trx,
      );
      // GSC can return tens of thousands of rows. Batch upserts avoid one
      // network round trip per metric while keeping transactions bounded.
      for (let offset = 0; offset < rows.length; offset += 500) {
        const batch = rows.slice(offset, offset + 500);
        await trx
          .insertInto('capere.analytics_daily')
          .values(
            batch.map((row) => ({
              organization_id: i.organization_id,
              integration_id: i.id,
              provider: i.provider,
              resource_id: i.account_id!,
              metric_date: row.date,
              dimensions: JSON.stringify(row.dimensions),
              metrics: JSON.stringify(row.metrics),
              source_updated_at: new Date(),
            })),
          )
          .onConflict((c) =>
            c
              .columns(['organization_id', 'provider', 'resource_id', 'metric_date', 'dimensions'])
              .doUpdateSet((eb) => ({
                metrics: eb.ref('excluded.metrics'),
                source_updated_at: eb.ref('excluded.source_updated_at'),
              })),
          )
          .execute();
      }
      await trx
        .insertInto('capere.integration_sync_states')
        .values({
          organization_id: i.organization_id,
          integration_id: i.id,
          dataset,
          status: 'succeeded',
          cursor,
          watermark_at: completedAt,
          last_started_at: completedAt,
          last_succeeded_at: completedAt,
          last_error: null,
          consecutive_failures: 0,
        })
        .onConflict((c) =>
          c.columns(['organization_id', 'integration_id', 'dataset']).doUpdateSet({
            status: 'succeeded',
            cursor,
            watermark_at: completedAt,
            last_started_at: completedAt,
            last_succeeded_at: completedAt,
            last_error: null,
            consecutive_failures: 0,
          }),
        )
        .execute();
      await trx
        .updateTable('capere.integrations')
        .set({ last_sync_at: completedAt, status: 'connected', last_error: null })
        .where('id', '=', i.id)
        .execute();
      await this.outbox.publishInTransaction(trx, {
        type: eventType,
        organizationId: i.organization_id,
        aggregateType: 'integration',
        aggregateId: i.id,
        payload: payload as never,
      });
    });
  }

  private googleDate(value: string): string {
    return value.length === 8
      ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
      : value;
  }
}
