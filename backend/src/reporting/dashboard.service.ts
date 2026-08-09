import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../shared/database';
import type { DashboardKind } from '../shared/database';

const DASHBOARDS: readonly DashboardKind[] = [
  'executive',
  'seo',
  'gbp',
  'lead',
  'revenue',
  'content',
];

@Injectable()
export class DashboardService {
  constructor(private readonly database: DatabaseService) {}

  kinds(): readonly DashboardKind[] {
    return DASHBOARDS;
  }

  async refresh(organizationId: string, days = 30): Promise<number> {
    const end = new Date();
    const start = new Date(end.getTime() - (days - 1) * 86_400_000);
    const rows = await this.database.db
      .selectFrom('capere.analytics_daily')
      .select(['integration_id', 'provider', 'resource_id', 'metric_date', 'dimensions', 'metrics'])
      .where('organization_id', '=', organizationId)
      .where('metric_date', '>=', start.toISOString().slice(0, 10))
      .where('metric_date', '<=', end.toISOString().slice(0, 10))
      .execute();

    const metrics: Array<{
      organization_id: string;
      dashboard: DashboardKind;
      metric_date: string;
      metric_name: string;
      metric_value: string;
      unit: string;
      dimension_key: string;
      dimension_value: string;
      source: string;
    }> = [];
    for (const row of rows) {
      const values = this.object(row.metrics);
      const dimensionEntries = Object.entries(this.object(row.dimensions)).sort(([a], [b]) =>
        a.localeCompare(b),
      );
      const dimensionKey = dimensionEntries.map(([key]) => key).join('|');
      const dimensionValue = dimensionEntries.map(([, value]) => String(value)).join('|');
      const source = `analytics_daily:${row.provider}:${row.integration_id}:${row.resource_id}`;
      const dashboard =
        row.provider === 'google_search_console'
          ? 'seo'
          : row.provider === 'google_business_profile'
            ? 'gbp'
            : 'executive';
      for (const [name, value] of Object.entries(values)) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) continue;
        const metricDate = this.dateString(row.metric_date);
        metrics.push({
          organization_id: organizationId,
          dashboard,
          metric_date: metricDate,
          metric_name: name,
          metric_value: String(numeric),
          unit: name.toLowerCase().includes('revenue') ? 'currency' : 'count',
          dimension_key: dimensionKey,
          dimension_value: dimensionValue,
          source,
        });
        if (dashboard === 'executive' && ['sessions', 'conversions', 'revenue'].includes(name)) {
          metrics.push({
            organization_id: organizationId,
            dashboard: 'revenue',
            metric_date: metricDate,
            metric_name: name,
            metric_value: String(numeric),
            unit: name === 'revenue' ? 'currency' : 'count',
            dimension_key: dimensionKey,
            dimension_value: dimensionValue,
            source,
          });
        }
      }
    }

    const insightRows = await this.database.db
      .selectFrom('capere.insights')
      .select(['category', 'severity'])
      .where('organization_id', '=', organizationId)
      .where('status', '=', 'active')
      .execute();
    const today = end.toISOString().slice(0, 10);
    const insightCounts = new Map<string, number>();
    for (const row of insightRows) {
      const key = `${row.category}:${row.severity}`;
      insightCounts.set(key, (insightCounts.get(key) ?? 0) + 1);
    }
    for (const [key, value] of insightCounts) {
      const [category, severity] = key.split(':');
      metrics.push({
        organization_id: organizationId,
        dashboard: category === 'seo' || category === 'gbp' ? category : 'executive',
        metric_date: today,
        metric_name: 'active_insights',
        metric_value: String(value),
        unit: 'count',
        dimension_key: 'severity',
        dimension_value: severity,
        source: 'insights_engine',
      });
    }

    await this.database.transaction(async (trx) => {
      await trx
        .deleteFrom('capere.dashboard_metrics')
        .where('organization_id', '=', organizationId)
        .where('metric_date', '>=', start.toISOString().slice(0, 10))
        .execute();
      for (let offset = 0; offset < metrics.length; offset += 500) {
        const batch = metrics.slice(offset, offset + 500);
        if (batch.length > 0)
          await trx.insertInto('capere.dashboard_metrics').values(batch).execute();
      }
    });
    return metrics.length;
  }

  async query(organizationId: string, dashboard: DashboardKind, days = 30) {
    const start = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    return this.database.db
      .selectFrom('capere.dashboard_metrics')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('dashboard', '=', dashboard)
      .where('metric_date', '>=', start)
      .orderBy('metric_date', 'desc')
      .orderBy('metric_name')
      .limit(10_000)
      .execute();
  }

  async generateExecutiveReport(organizationId: string, end = new Date()) {
    const periodEnd = this.dateString(end);
    const startDate = new Date(end.getTime() - 6 * 86_400_000);
    const periodStart = this.dateString(startDate);
    const metrics = await this.database.db
      .selectFrom('capere.dashboard_metrics')
      .select(['metric_name', 'metric_value', 'unit'])
      .where('organization_id', '=', organizationId)
      .where('metric_date', '>=', periodStart)
      .where('metric_date', '<=', periodEnd)
      .where('dashboard', '=', 'executive')
      .execute();
    const recommendations = await this.database.db
      .selectFrom('capere.recommendations')
      .select(['title', 'priority', 'action'])
      .where('organization_id', '=', organizationId)
      .where('status', 'in', ['proposed', 'approved', 'in_progress'])
      .orderBy('created_at', 'desc')
      .limit(10)
      .execute();
    const lines = [
      `Executive Growth Report: ${periodStart} to ${periodEnd}`,
      '',
      'Observed metrics:',
      ...metrics
        .slice(0, 30)
        .map((row) => `- ${row.metric_name}: ${row.metric_value} (${row.unit})`),
      '',
      'Open recommendations:',
      ...recommendations.map((row) => `- [${row.priority}] ${row.title}: ${row.action}`),
    ];
    const report = await this.database.db
      .insertInto('capere.executive_reports')
      .values({
        organization_id: organizationId,
        period_start: periodStart,
        period_end: periodEnd,
        title: `Executive Growth Report ${periodEnd}`,
        content: lines.join('\n'),
        metrics: JSON.stringify(metrics),
      })
      .onConflict((oc) =>
        oc.columns(['organization_id', 'period_start', 'period_end']).doUpdateSet({
          content: lines.join('\n'),
          metrics: JSON.stringify(metrics),
          generated_at: new Date(),
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return report;
  }

  async latestReport(organizationId: string) {
    return this.database.db
      .selectFrom('capere.executive_reports')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .orderBy('period_end', 'desc')
      .limit(1)
      .executeTakeFirst();
  }

  async cmoBrief(organizationId: string) {
    const [recommendations, metrics] = await Promise.all([
      this.database.db
        .selectFrom('capere.recommendations')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('status', 'in', ['proposed', 'approved', 'in_progress'])
        .orderBy('priority', 'desc')
        .limit(10)
        .execute(),
      this.query(organizationId, 'executive', 7),
    ]);
    return {
      generatedAt: new Date().toISOString(),
      recommendations,
      metrics,
      evidenceComplete: metrics.length > 0,
    };
  }

  async seoCommandCenter(organizationId: string) {
    let metrics = await this.query(organizationId, 'seo', 30);
    if (metrics.length === 0) {
      await this.refresh(organizationId);
      metrics = await this.query(organizationId, 'seo', 30);
    }
    const [recommendationsResult, technicalAuditResult, auditHistoryResult, projectResult, keywordsResult, competitorsResult, integrationsResult] = await Promise.allSettled([
      this.database.db
        .selectFrom('capere.recommendations')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('category', '=', 'seo')
        .where('status', 'in', ['proposed', 'approved', 'in_progress'])
        .orderBy('created_at', 'desc')
        .limit(25)
        .execute(),
      this.database.db
        .selectFrom('capere.technical_audits as a')
        .innerJoin('capere.seo_projects as p', (join) =>
          join
            .onRef('p.organization_id', '=', 'a.organization_id')
            .onRef('p.id', '=', 'a.seo_project_id'),
        )
        .select([
          'a.id',
          'a.status',
          'a.score',
          'a.issue_count',
          'a.summary',
          'a.started_at',
          'a.completed_at',
          'p.site_url',
        ])
        .where('a.organization_id', '=', organizationId)
        .where('a.status', '=', 'succeeded')
        .orderBy('a.completed_at', 'desc')
        .limit(1)
        .executeTakeFirst(),
      this.database.db.selectFrom('capere.technical_audits').select(['id','status','score','issue_count','started_at','completed_at']).where('organization_id','=',organizationId).orderBy('created_at','desc').limit(10).execute(),
      this.database.db.selectFrom('capere.seo_projects').select(['id','name','site_url','enabled','target_location_code','language_code']).where('organization_id','=',organizationId).where('enabled','=',true).orderBy('created_at','desc').limit(1).executeTakeFirst(),
      this.database.db.selectFrom('capere.keywords as k').leftJoin('capere.keyword_rankings as r','r.keyword_id','k.id').select(['k.keyword','k.tags','r.rank','r.checked_on','r.url']).where('k.organization_id','=',organizationId).where('k.enabled','=',true).orderBy('r.checked_on','desc').limit(50).execute(),
      this.database.db.selectFrom('capere.competitors').select(['domain','name','metrics','last_checked_at']).where('organization_id','=',organizationId).orderBy('last_checked_at','desc').limit(25).execute(),
      this.database.db.selectFrom('capere.integrations').select(['provider','status','last_sync_at','last_error']).where('organization_id','=',organizationId).execute(),
    ]);
    const value = <T>(result: PromiseSettledResult<T>, fallback: T): T => result.status === 'fulfilled' ? result.value : fallback;
    const recommendations = value(recommendationsResult, []);
    const technicalAudit = value(technicalAuditResult, undefined);
    const auditHistory = value(auditHistoryResult, []);
    const project = value(projectResult, undefined);
    const keywords = value(keywordsResult, []);
    const competitors = value(competitorsResult, []);
    const integrations = value(integrationsResult, []);
    return {
      generatedAt: new Date().toISOString(),
      metrics,
      recommendations,
      technicalAudit: technicalAudit ?? null,
      auditHistory,
      project: project ?? null,
      keywords,
      competitors,
      integrations,
      evidenceComplete: metrics.length > 0 || Boolean(technicalAudit),
    };
  }

  async generateDailyBrief(organizationId: string, date = new Date()) {
    const day = this.dateString(date);
    const brief = await this.cmoBrief(organizationId);
    const content = [
      `Morning Brief: ${day}`,
      ...brief.recommendations
        .slice(0, 5)
        .map((row) => `- [${row.priority}] ${row.title}: ${row.action}`),
    ].join('\n');
    return this.database.db
      .insertInto('capere.generated_artifacts')
      .values({
        organization_id: organizationId,
        kind: 'daily_brief',
        artifact_date: day,
        title: `Morning Brief ${day}`,
        content,
        evidence: JSON.stringify({ metricCount: brief.metrics.length }),
      })
      .onConflict((oc) =>
        oc.columns(['organization_id', 'kind', 'artifact_date', 'title']).doUpdateSet({
          content,
          evidence: JSON.stringify({ metricCount: brief.metrics.length }),
          updated_at: new Date(),
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  artifacts(organizationId: string, kind?: 'daily_brief' | 'content_draft') {
    let query = this.database.db
      .selectFrom('capere.generated_artifacts')
      .selectAll()
      .where('organization_id', '=', organizationId);
    if (kind) query = query.where('kind', '=', kind);
    return query.orderBy('artifact_date', 'desc').limit(100).execute();
  }

  private object(value: unknown): Record<string, unknown> {
    if (typeof value === 'string') {
      try {
        return JSON.parse(value) as Record<string, unknown>;
      } catch {
        return {};
      }
    }
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private dateString(value: unknown): string {
    return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  }
}
