import { Injectable, Optional } from '@nestjs/common';
import { DatabaseService } from '../shared/database';
import type { DashboardKind } from '../shared/database';
import { GhlAdapter } from '../integrations/ghl/ghl.adapter';
import { GhlTokenService } from '../integrations/ghl/ghl-token.service';
import { GhlReputationService } from '../integrations/ghl/ghl-reputation.service';
import { GhlBusinessSnapshotService } from '../integrations/ghl/ghl-business-snapshot.service';

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
  constructor(private readonly database: DatabaseService, @Optional() private readonly ghl?: GhlAdapter, @Optional() private readonly ghlTokens?: GhlTokenService, @Optional() private readonly ghlReputation?: GhlReputationService, @Optional() private readonly ghlBusiness?: GhlBusinessSnapshotService) {}

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
        .selectFrom('capere.recommendations as r')
        .leftJoin('capere.insights as i', (join) => join.onRef('i.organization_id','=','r.organization_id').onRef('i.id','=','r.source_insight_id'))
        .selectAll('r')
        .where('r.organization_id', '=', organizationId)
        .where('r.status', 'in', ['proposed', 'approved', 'in_progress'])
        .where((eb) => eb.or([eb('r.source_insight_id','is',null),eb('i.status','=','active')]))
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

  async cmoSummary(organizationId: string) {
    await this.ensureCmoSchedules(organizationId);
    let metrics = await this.query(organizationId, 'executive', 30);
    if (metrics.length === 0) {
      await this.refresh(organizationId);
      metrics = await this.query(organizationId, 'executive', 30);
    }
    const [seoMetrics, sourceRows] = await Promise.all([
      this.query(organizationId, 'seo', 30),
      this.database.db.selectFrom('capere.analytics_daily').select(['provider','metric_date','dimensions','metrics']).where('organization_id','=',organizationId).where('metric_date','>=',new Date(Date.now() - 13 * 86_400_000).toISOString().slice(0, 10)).execute(),
    ]);
    const performance = this.cmoPerformanceFromSource(sourceRows);
    const [insights, recommendations, briefs, tasks, integrations] = await Promise.all([
      this.database.db.selectFrom('capere.insights').select(['id','category','severity','title','body','confidence','created_at']).where('organization_id','=',organizationId).where('status','=','active').orderBy('created_at','desc').limit(30).execute(),
      this.database.db.selectFrom('capere.recommendations as r').leftJoin('capere.insights as i',(join)=>join.onRef('i.organization_id','=','r.organization_id').onRef('i.id','=','r.source_insight_id')).selectAll('r').where('r.organization_id','=',organizationId).where('r.status','in',['proposed','approved','in_progress']).where((eb)=>eb.or([eb('r.source_insight_id','is',null),eb('i.status','=','active')])).orderBy('r.created_at','desc').limit(30).execute(),
      this.database.db.selectFrom('capere.generated_artifacts').select(['id','artifact_date','title','content','status','created_at']).where('organization_id','=',organizationId).where('kind','=','daily_brief').orderBy('artifact_date','desc').limit(10).execute(),
      this.database.db.selectFrom('capere.automation_actions').select(['id','kind','status','title','payload','error','approved_at','executed_at','created_at']).where('organization_id','=',organizationId).orderBy('created_at','desc').limit(30).execute(),
      this.database.db.selectFrom('capere.integrations').select(['provider','status','last_sync_at','last_error']).where('organization_id','=',organizationId).execute(),
    ]);
    const [pipeline, operations, businessProfile] = await Promise.all([
      this.pipelineSummary(organizationId),
      this.ghlBusiness ? this.ghlBusiness.summary(organizationId) : Promise.resolve(null),
      this.ghlReputation ? this.ghlReputation.summary(organizationId) : Promise.resolve(null),
    ]);
    return { generatedAt:new Date().toISOString(), metrics, seoMetrics, performance, insights, recommendations, briefs, tasks, integrations, pipeline, operations, businessProfile, evidenceComplete:metrics.length>0||seoMetrics.length>0||insights.length>0||recommendations.length>0||pipeline.connected||Boolean(operations?.connected) };
  }

  async ghlBusinessProfileConnectUrl(organizationId: string) {
    const integration = await this.database.db
      .selectFrom('capere.integrations')
      .select('account_id')
      .where('organization_id', '=', organizationId)
      .where('provider', '=', 'go_high_level')
      .where('status', '=', 'connected')
      .orderBy('created_at', 'asc')
      .executeTakeFirst();
    if (!integration?.account_id) return null;
    return `https://app.gohighlevel.com/v2/location/${encodeURIComponent(integration.account_id)}/reputation/gbp`;
  }

  private cmoPerformanceFromSource(rows: Array<{ provider: string; metric_date: Date | string; dimensions: unknown; metrics: unknown }>) {
    const today = new Date();
    const currentStart = new Date(today.getTime() - 6 * 86_400_000).toISOString().slice(0, 10);
    const previousStart = new Date(today.getTime() - 13 * 86_400_000).toISOString().slice(0, 10);
    const previousEnd = new Date(today.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
    const end = today.toISOString().slice(0, 10);
    const total = (provider: string, metric: string, start: string, finish: string) => rows.filter((row) => row.provider === provider && this.dateString(row.metric_date) >= start && this.dateString(row.metric_date) <= finish && (provider !== 'google_search_console' || JSON.stringify(this.object(row.dimensions)) === '{}')).reduce((sum, row) => sum + (Number(this.object(row.metrics)[metric] ?? 0) || 0), 0);
    return { periodDays: 7, currentSessions: total('google_analytics_4','sessions',currentStart,end), previousSessions: total('google_analytics_4','sessions',previousStart,previousEnd), currentSearchClicks: total('google_search_console','clicks',currentStart,end), currentSearchImpressions: total('google_search_console','impressions',currentStart,end), searchAveragePosition: null };
  }

  private async pipelineSummary(organizationId: string) {
    if (!this.ghl || !this.ghlTokens) return { connected:false, returned:0, total:0, pipelineValue:0, byStatus:{}, error:'GoHighLevel pipeline data is unavailable.' };
    const integration = await this.database.db.selectFrom('capere.integrations').select(['id','account_id','account_name']).where('organization_id','=',organizationId).where('provider','=','go_high_level').where('status','=','connected').orderBy('created_at','asc').executeTakeFirst();
    if (!integration?.account_id) return { connected:false, returned:0, total:0, pipelineValue:0, byStatus:{}, error:'GoHighLevel is not connected.' };
    try {
      const credentials = await this.ghlTokens.credentials(organizationId, integration.id);
      const opportunities: Array<{status?:string;monetaryValue?:number}> = []; let page=1; let reportedTotal:number|undefined;
      while(opportunities.length<500){ const body=await this.ghl.getJson<{opportunities?:Array<{status?:string;monetaryValue?:number}>;meta?:{total?:number;nextPage?:number|null}}>(credentials,'opportunities/search',{location_id:integration.account_id,limit:Math.min(100,500-opportunities.length),page}); const rows=body.opportunities??[]; opportunities.push(...rows); reportedTotal??=body.meta?.total; if(!rows.length||opportunities.length>=500||(reportedTotal!==undefined&&opportunities.length>=reportedTotal)) break; page=body.meta?.nextPage??page+1; }
      const byStatus:Record<string,number>={}; let pipelineValue=0; for(const opportunity of opportunities){const status=opportunity.status??'unknown';byStatus[status]=(byStatus[status]??0)+1;pipelineValue+=Number(opportunity.monetaryValue??0)||0;}
      return {connected:true,integrationId:integration.id,locationName:integration.account_name,returned:opportunities.length,total:reportedTotal??opportunities.length,pipelineValue,byStatus,error:null};
    } catch(error) { return {connected:true,returned:0,total:0,pipelineValue:0,byStatus:{},error:error instanceof Error?error.message:'GoHighLevel pipeline data is unavailable.'}; }
  }

  /** Ensures the CMO pipeline exists for older organizations created before
   * the scheduler provisioning was introduced. The conflict key makes this
   * safe to call from every dashboard request and for every tenant. */
  private async ensureCmoSchedules(organizationId: string): Promise<void> {
    const now = Date.now();
    const jobs = [
      { jobType: 'insights-sweep', name: `insights-sweep:${organizationId}`, schedule: 'daily', delay: 0 },
      { jobType: 'recommendation-sweep', name: `recommendation-sweep:${organizationId}`, schedule: 'daily', delay: 90_000 },
      { jobType: 'dashboard-refresh', name: `dashboard-refresh:${organizationId}`, schedule: 'daily', delay: 180_000 },
      { jobType: 'daily-brief', name: `daily-brief:${organizationId}`, schedule: 'daily', delay: 270_000 },
      { jobType: 'weekly-report', name: `weekly-report:${organizationId}`, schedule: 'weekly', delay: 360_000 },
    ] as const;
    for (const job of jobs) {
      await this.database.db.insertInto('capere.scheduled_jobs').values({
        organization_id: organizationId,
        job_type: job.jobType,
        name: job.name,
        schedule: job.schedule,
        enabled: true,
        next_run_at: new Date(now + job.delay),
        payload: JSON.stringify({ organizationId }),
      }).onConflict((oc) => oc.columns(['organization_id','name']).doUpdateSet({ enabled: true })).execute();
    }
  }

  async seoCommandCenter(organizationId: string) {
    let metrics = await this.query(organizationId, 'seo', 30);
    if (metrics.length === 0) {
      await this.refresh(organizationId);
      metrics = await this.query(organizationId, 'seo', 30);
    }
    const queryStart = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
    const [recommendationsResult, technicalAuditResult, auditHistoryResult, projectResult, keywordsResult, searchQueryRowsResult, competitorsResult, integrationsResult, localProfileResult] = await Promise.allSettled([
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
      this.database.db.selectFrom('capere.keywords as k').leftJoin('capere.keyword_rankings as r','r.keyword_id','k.id').select(['k.keyword','k.tags','r.rank','r.checked_on','r.url','r.raw_summary']).where('k.organization_id','=',organizationId).where('k.enabled','=',true).orderBy('r.checked_on','desc').limit(50).execute(),
      this.database.db
        .selectFrom('capere.analytics_daily')
        .select(['metric_date', 'dimensions', 'metrics'])
        .where('organization_id', '=', organizationId)
        .where('provider', '=', 'google_search_console')
        .where('metric_date', '>=', queryStart)
        .orderBy('metric_date', 'desc')
        .execute(),
      this.database.db.selectFrom('capere.competitors').select(['domain','name','metrics','last_checked_at']).where('organization_id','=',organizationId).orderBy('last_checked_at','desc').limit(25).execute(),
      this.database.db.selectFrom('capere.integrations').select(['provider','status','last_sync_at','last_error']).where('organization_id','=',organizationId).execute(),
      this.ghlReputation ? this.ghlReputation.summary(organizationId) : Promise.resolve(null),
    ]);
    const value = <T>(result: PromiseSettledResult<T>, fallback: T): T => result.status === 'fulfilled' ? result.value : fallback;
    const recommendations = value(recommendationsResult, []);
    const technicalAudit = value(technicalAuditResult, undefined);
    const auditHistory = value(auditHistoryResult, []);
    const project = value(projectResult, undefined);
    const keywords = value(keywordsResult, []);
    const searchQueryRows = value(searchQueryRowsResult, []);
    const searchQueryMap = new Map<string, { query: string; clicks: number; impressions: number; weightedPosition: number; latestDate: string }>();
    for (const row of searchQueryRows) {
      const dimensions = this.object(row.dimensions);
      const query = typeof dimensions.query === 'string' ? dimensions.query.trim() : '';
      if (!query) continue;
      const rowMetrics = this.object(row.metrics);
      const clicks = Number(rowMetrics.clicks ?? 0);
      const impressions = Number(rowMetrics.impressions ?? 0);
      const position = Number(rowMetrics.position ?? 0);
      const metricDate = this.dateString(row.metric_date);
      const current = searchQueryMap.get(query) ?? { query, clicks: 0, impressions: 0, weightedPosition: 0, latestDate: metricDate };
      current.clicks += Number.isFinite(clicks) ? clicks : 0;
      current.impressions += Number.isFinite(impressions) ? impressions : 0;
      if (Number.isFinite(position)) current.weightedPosition += position * Math.max(impressions, 1);
      if (metricDate > current.latestDate) current.latestDate = metricDate;
      searchQueryMap.set(query, current);
    }
    const searchQueries = [...searchQueryMap.values()]
      .map((row) => ({
        query: row.query,
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: row.impressions > 0 ? row.clicks / row.impressions : 0,
        position: row.weightedPosition / Math.max(row.impressions, 1),
        latestDate: row.latestDate,
      }))
      .sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks)
      .slice(0, 25);
    const competitors = value(competitorsResult, []);
    const integrations = value(integrationsResult, []);
    const localProfile = value(localProfileResult, null);
    return {
      generatedAt: new Date().toISOString(),
      metrics,
      recommendations,
      technicalAudit: technicalAudit ?? null,
      technicalFindings: technicalAudit ? this.technicalFindings(technicalAudit.summary) : [],
      technicalOverview: technicalAudit ? this.technicalOverview(technicalAudit.summary) : null,
      auditHistory,
      project: project ?? null,
      keywords,
      searchQueries,
      competitors,
      integrations,
      localProfile,
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

  private technicalFindings(summary: unknown) {
    const root = this.object(summary);
    const domainChecks = this.object(this.object(root['domain_info'])['checks']);
    const pageChecks = this.object(this.object(root['page_metrics'])['checks']);
    const catalog: Record<string, { title: string; severity: 'high' | 'medium' | 'low'; meaning: string; action: string }> = {
      sitemap: { title: 'XML sitemap not detected', severity: 'high', meaning: 'Search engines have less guidance for discovering and prioritizing pages.', action: 'Publish an XML sitemap and reference it in robots.txt and Search Console.' },
      robots_txt: { title: 'robots.txt not detected', severity: 'medium', meaning: 'Crawler access rules and sitemap location are not explicitly declared.', action: 'Add a robots.txt file with appropriate crawl rules and a sitemap URL.' },
      no_image_title: { title: 'Image title attribute missing', severity: 'low', meaning: 'At least one image lacks optional descriptive title metadata.', action: 'Add useful image titles where they improve context; prioritize accurate alt text first.' },
      has_render_blocking_resources: { title: 'Render-blocking resources detected', severity: 'medium', meaning: 'CSS or JavaScript may delay the initial visible page render.', action: 'Inline critical CSS, defer non-critical scripts, and preload essential assets.' },
    };
    const findings: Array<{ code: string; title: string; severity: string; count: number; meaning: string; action: string }> = [];
    for (const key of ['sitemap', 'robots_txt']) {
      if (domainChecks[key] === false) findings.push({ code: key, count: 1, ...catalog[key] });
    }
    for (const [key, raw] of Object.entries(pageChecks)) {
      const count = Number(raw);
      if (count > 0 && catalog[key]) findings.push({ code: key, count, ...catalog[key] });
    }
    return findings;
  }

  private technicalOverview(summary: unknown) {
    const root = this.object(summary);
    const domain = this.object(root['domain_info']);
    const domainChecks = this.object(domain['checks']);
    const ssl = this.object(domain['ssl_info']);
    const crawl = this.object(root['crawl_status']);
    const pages = this.object(root['page_metrics']);
    return {
      pagesCrawled: Number(crawl['pages_crawled'] ?? domain['total_pages'] ?? 0),
      totalPages: Number(domain['total_pages'] ?? crawl['pages_crawled'] ?? 0),
      pagesQueued: Number(crawl['pages_in_queue'] ?? 0),
      crawlLimit: Number(crawl['max_crawl_pages'] ?? 0),
      crawlStatus: String(root['crawl_progress'] ?? domain['extended_crawl_status'] ?? 'unknown'),
      crawlStopReason: String(root['crawl_stop_reason'] ?? 'unknown'),
      crawlStartedAt: domain['crawl_start'] ?? null,
      crawlEndedAt: domain['crawl_end'] ?? null,
      internalLinks: Number(pages['links_internal'] ?? 0),
      externalLinks: Number(pages['links_external'] ?? 0),
      brokenLinks: Number(pages['broken_links'] ?? 0),
      brokenResources: Number(pages['broken_resources'] ?? 0),
      nonIndexablePages: Number(pages['non_indexable'] ?? 0),
      duplicateContent: Number(pages['duplicate_content'] ?? 0),
      https: domainChecks['ssl'] === true,
      http2: domainChecks['http2'] === true,
      sitemap: domainChecks['sitemap'] === true,
      robotsTxt: domainChecks['robots_txt'] === true,
      certificateValid: ssl['valid_certificate'] === true,
      certificateExpiresAt: ssl['certificate_expiration_date'] ?? null,
      ip: domain['ip'] ?? null,
    };
  }

  private dateString(value: unknown): string {
    return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  }
}
