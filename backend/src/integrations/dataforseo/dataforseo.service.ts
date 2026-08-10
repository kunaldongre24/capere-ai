import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../shared/config';
import { sql } from 'kysely';
import { DatabaseService } from '../../shared/database';
import { EventType, OutboxService } from '../../shared/events';
import { AppException, ErrorCode } from '../../shared/http';
import { DataForSeoAdapter } from './dataforseo.adapter';
import type { CreateCompetitorDto, CreateSeoProjectDto, RunSeoAuditDto } from './dataforseo.dto';

@Injectable()
export class DataForSeoService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly database: DatabaseService,
    private readonly adapter: DataForSeoAdapter,
    private readonly outbox: OutboxService,
  ) {}

  private async ensurePlatformIntegration(organizationId: string) {
    return this.database.db
      .insertInto('capere.integrations')
      .values({
        organization_id: organizationId,
        ghl_location_id: null,
        provider: 'data_for_seo',
        account_id: 'capere-platform',
        account_name: 'Capere DataForSEO',
        status: 'connected',
        encrypted_credentials: null,
        key_version: 1,
        scopes: 'read',
        token_type: 'Basic',
        expires_at: null,
        last_sync_at: null,
        last_error: null,
        provider_metadata: JSON.stringify({ billingOwner: 'capere' }),
        authorization_id: null,
        sync_enabled: true,
      })
      .onConflict((c) =>
        c
          .columns(['organization_id', 'provider', 'account_id'])
          .where('provider', '<>', 'go_high_level')
          .doUpdateSet({ status: 'connected', last_error: null }),
      )
      .returning(['id', 'provider', 'status'])
      .executeTakeFirstOrThrow();
  }

  async addCompetitor(organizationId: string, projectId: string, dto: CreateCompetitorDto) {
    const project = await this.database.db.selectFrom('capere.seo_projects').select('id').where('organization_id','=',organizationId).where('id','=',projectId).executeTakeFirst();
    if (!project) throw AppException.notFound(ErrorCode.NOT_FOUND, 'SEO project not found');
    let domain = dto.domain.trim().toLowerCase();
    try { domain = new URL(domain.includes('://') ? domain : `https://${domain}`).hostname.toLowerCase().replace(/^www\./,'').replace(/\.$/,''); } catch { throw AppException.badRequest(ErrorCode.BAD_REQUEST, 'Enter a valid competitor website'); }
    if (!domain || domain.includes(' ')) throw AppException.badRequest(ErrorCode.BAD_REQUEST, 'Enter a valid competitor website');
    const existing = await this.database.db.selectFrom('capere.competitors').select('id').where('organization_id','=',organizationId).where('seo_project_id','=',projectId).where('domain','=',domain).executeTakeFirst();
    const count = await this.database.db.selectFrom('capere.competitors').select((eb) => eb.fn.countAll<number>().as('count')).where('organization_id','=',organizationId).where('seo_project_id','=',projectId).executeTakeFirstOrThrow();
    if (!existing && Number(count.count) >= 10) throw AppException.badRequest(ErrorCode.BAD_REQUEST, 'You can compare up to 10 businesses per website');
    const competitor = await this.database.db.insertInto('capere.competitors').values({ organization_id: organizationId, seo_project_id: projectId, domain, name: dto.name.trim(), metrics: JSON.stringify({ status: 'configured', message: 'Comparison data will appear after the next refresh.' }), last_checked_at: null }).onConflict((c)=>c.columns(['organization_id','seo_project_id','domain']).doUpdateSet({name:dto.name.trim(),updated_at:new Date()})).returningAll().executeTakeFirstOrThrow();
    await this.database.db.insertInto('capere.scheduled_jobs').values({ organization_id: organizationId, job_type: 'dataforseo-competitor-refresh', name: `dataforseo-competitors:${projectId}`, schedule: 'weekly', enabled: true, next_run_at: new Date(Date.now() + 7 * 86_400_000), payload: JSON.stringify({ projectId }) }).onConflict((oc) => oc.columns(['organization_id','name']).doUpdateSet({ enabled: true, payload: JSON.stringify({ projectId }) })).execute();
    await this.refreshCompetitors(organizationId, projectId);
    return this.database.db.selectFrom('capere.competitors').selectAll().where('organization_id','=',organizationId).where('id','=',competitor.id).executeTakeFirstOrThrow();
  }

  async refreshCompetitors(organizationId: string, projectId: string) {
    const project = await this.database.db.selectFrom('capere.seo_projects').selectAll().where('organization_id','=',organizationId).where('id','=',projectId).executeTakeFirst();
    if (!project) throw AppException.notFound(ErrorCode.NOT_FOUND, 'SEO project not found');
    const competitors = await this.database.db.selectFrom('capere.competitors').selectAll().where('organization_id','=',organizationId).where('seo_project_id','=',projectId).orderBy('created_at').limit(10).execute();
    if (!competitors.length) return { refreshed: 0, message: 'Add at least one competitor before refreshing comparisons.' };
    const cooldown = Date.now() - 6 * 3_600_000;
    if (competitors.every((competitor) => competitor.last_checked_at && new Date(competitor.last_checked_at).getTime() >= cooldown)) return { refreshed: 0, cached: true, message: 'Comparison data is already current.' };
    const target = new URL(project.site_url).hostname.toLowerCase().replace(/^www\./, '');
    const request = { targets: [target, ...competitors.map((c) => c.domain)], location_code: project.target_location_code, language_code: project.language_code };
    const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const integration = await this.ensurePlatformIntegration(organizationId);
    const response = await this.adapter.postTask<Record<string, unknown>>('dataforseo_labs/google/bulk_traffic_estimation/live', request);
    const task = response.tasks?.[0];
    const result = task?.result?.[0] as {
      items?: Array<{
        target?: string;
        metrics?: Record<string, { etv?: number; count?: number } | null>;
      }>;
    } | undefined;
    if (!result?.items) throw AppException.serviceUnavailable(ErrorCode.INTEGRATION_ERROR, 'DataForSEO did not return competitor data');
    const byTarget = new Map(result.items.map((item) => [String(item.target ?? '').replace(/^www\./, ''), item]));
    const targetItem = byTarget.get(target);
    await this.database.transaction(async (trx) => {
      await trx.insertInto('capere.provider_tasks').values({ organization_id: organizationId, integration_id: integration.id, provider: 'data_for_seo', task_type: 'competitor_bulk_traffic', request_fingerprint: fingerprint, provider_task_id: task?.id ?? null, status: 'succeeded', request: JSON.stringify(request), result: JSON.stringify(result), cost_micro_usd: String(Math.round((task?.cost ?? 0) * 1_000_000)), attempts: 1, next_poll_at: null, error: null }).onConflict((oc) => oc.columns(['organization_id','provider','task_type','request_fingerprint']).doUpdateSet({ result: JSON.stringify(result), status: 'succeeded', cost_micro_usd: String(Math.round((task?.cost ?? 0) * 1_000_000)), updated_at: new Date() })).execute();
      for (const competitor of competitors) {
        const item = byTarget.get(competitor.domain);
        const organic = item?.metrics?.organic ?? { etv: 0, count: 0 };
        const paid = item?.metrics?.paid ?? { etv: 0, count: 0 };
        await trx.updateTable('capere.competitors').set({ metrics: JSON.stringify({ status: item ? 'ready' : 'no_data', organicTraffic: Number(organic?.etv ?? 0), rankingKeywords: Number(organic?.count ?? 0), paidTraffic: Number(paid?.etv ?? 0), paidKeywords: Number(paid?.count ?? 0), targetOrganicTraffic: Number(targetItem?.metrics?.organic?.etv ?? 0), targetRankingKeywords: Number(targetItem?.metrics?.organic?.count ?? 0), locationCode: project.target_location_code, languageCode: project.language_code }), last_checked_at: new Date(), updated_at: new Date() }).where('organization_id','=',organizationId).where('id','=',competitor.id).execute();
      }
    });
    return { refreshed: competitors.length, cost: task?.cost ?? 0, checkedAt: new Date().toISOString() };
  }

  async removeCompetitor(organizationId: string, projectId: string, competitorId: string) {
    const deleted = await this.database.db.deleteFrom('capere.competitors').where('organization_id','=',organizationId).where('seo_project_id','=',projectId).where('id','=',competitorId).returning('id').executeTakeFirst();
    if (!deleted) throw AppException.notFound(ErrorCode.NOT_FOUND, 'Competitor not found');
    return { deleted: true, id: deleted.id };
  }

  async createProject(organizationId: string, dto: CreateSeoProjectDto) {
    const url = new URL(dto.siteUrl);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    const sharedHosts = ['vercel.app', 'netlify.app', 'pages.dev', 'github.io'];
    if (sharedHosts.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
      throw AppException.badRequest(ErrorCode.BAD_REQUEST, 'Please use a verified custom domain');
    }
    try {
      let response = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(5000) });
      if (response.status === 405) {
        response = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(5000), headers: { range: 'bytes=0-1023' } });
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      throw AppException.badRequest(ErrorCode.BAD_REQUEST, 'Website is not reachable; verify the URL and try again');
    }
    await this.ensurePlatformIntegration(organizationId);
    const project = await this.database.db
      .insertInto('capere.seo_projects')
      .values({
        organization_id: organizationId,
        name: dto.name,
        site_url: url.toString().replace(/\/$/, ''),
        target_location_code: dto.targetLocationCode,
        language_code: dto.languageCode,
        enabled: true,
      })
      .onConflict((c) =>
        c.columns(['organization_id', 'site_url']).doUpdateSet({
          name: dto.name,
          target_location_code: dto.targetLocationCode,
          language_code: dto.languageCode,
          enabled: true,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.database.db
      .insertInto('capere.scheduled_jobs')
      .values({
        organization_id: organizationId,
        job_type: 'dataforseo-audit-submit',
        name: `dataforseo-audit:${project.id}`,
        schedule: 'weekly',
        enabled: true,
        next_run_at: new Date(),
        payload: JSON.stringify({ projectId: project.id, maxCrawlPages: 20 }),
      })
      .onConflict((c) => c.columns(['organization_id', 'name']).doUpdateSet({
        enabled: true,
        next_run_at: new Date(),
        payload: JSON.stringify({ projectId: project.id, maxCrawlPages: 20 }),
      }))
      .execute();
    return project;
  }

  async submitAudit(organizationId: string, projectId: string, dto: RunSeoAuditDto) {
    const project = await this.database.db
      .selectFrom('capere.seo_projects')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', projectId)
      .executeTakeFirst();
    if (!project) throw AppException.notFound(ErrorCode.NOT_FOUND, 'SEO project not found');
    const integration = await this.ensurePlatformIntegration(organizationId);
    const request = {
      target: new URL(project.site_url).hostname,
      max_crawl_pages: Math.min(dto.maxCrawlPages || 20, 20),
      enable_javascript: false,
      pingback_url: this.config.dataForSeo.pingbackUrl || undefined,
      tag: `capere:${organizationId}:${project.id}`,
    };
    const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    return this.database.transaction(async (trx) => {
      // The external task is billable. Serialize identical submissions before
      // checking and calling the provider so concurrent HTTP requests cannot
      // purchase two audits and only discover the conflict at the local unique
      // constraint afterward.
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`dataforseo:${organizationId}:${fingerprint}`}, 0))`.execute(
        trx,
      );
      const existing = await trx
        .selectFrom('capere.provider_tasks')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('provider', '=', 'data_for_seo')
        .where('task_type', '=', 'on_page_audit')
        .where('request_fingerprint', '=', fingerprint)
        .executeTakeFirst();
      if (existing) return existing;
      const response = await this.adapter.postTask('on_page/task_post', request);
      const providerTask = response.tasks?.[0];
      if (!providerTask?.id)
        throw AppException.serviceUnavailable(
          ErrorCode.INTEGRATION_ERROR,
          'DataForSEO did not accept the audit',
        );
      const task = await trx
        .insertInto('capere.provider_tasks')
        .values({
          organization_id: organizationId,
          integration_id: integration.id,
          provider: 'data_for_seo',
          task_type: 'on_page_audit',
          request_fingerprint: fingerprint,
          provider_task_id: providerTask.id,
          status: 'polling',
          request: JSON.stringify(request),
          result: null,
          cost_micro_usd: String(Math.round((providerTask.cost ?? 0) * 1_000_000)),
          attempts: 1,
          next_poll_at: new Date(Date.now() + 60_000),
          error: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('capere.technical_audits')
        .values({
          organization_id: organizationId,
          seo_project_id: project.id,
          provider_task_id: task.id,
          status: 'polling',
          score: null,
          issue_count: null,
          summary: JSON.stringify({}),
          completed_at: null,
        })
        .execute();
      await trx
        .insertInto('capere.scheduled_jobs')
        .values({
          organization_id: organizationId,
          job_type: 'dataforseo-audit-poll',
          name: `dataforseo-audit-poll:${task.id}`,
          schedule: 'hourly',
          enabled: true,
          next_run_at: new Date(Date.now() + 60_000),
          payload: JSON.stringify({ taskId: task.id }),
        })
        .execute();
      return task;
    });
  }

  async pollAudit(organizationId: string, taskId: string) {
    const task = await this.database.db
      .selectFrom('capere.provider_tasks')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', taskId)
      .executeTakeFirst();
    if (!task?.provider_task_id)
      throw AppException.notFound(ErrorCode.NOT_FOUND, 'Provider task not found');
    const response = await this.adapter.postTask<Record<string, unknown>>('on_page/summary', {
      id: task.provider_task_id,
    });
    const providerTask = response.tasks?.[0];
    const result = providerTask?.result?.[0];
    if (!result) return { ready: false };
    const audit = await this.database.db
      .selectFrom('capere.technical_audits as a')
      .innerJoin('capere.seo_projects as p', 'p.id', 'a.seo_project_id')
      .select(['a.id', 'a.seo_project_id', 'p.site_url'])
      .where('a.organization_id', '=', organizationId)
      .where('a.provider_task_id', '=', task.id)
      .executeTakeFirstOrThrow();
    const score = this.score(result);
    const issueCount = this.issueCount(result);
    await this.database.transaction(async (trx) => {
      await trx
        .updateTable('capere.provider_tasks')
        .set({
          status: 'succeeded',
          result: JSON.stringify(result),
          next_poll_at: null,
          error: null,
        })
        .where('id', '=', task.id)
        .execute();
      await trx
        .updateTable('capere.technical_audits')
        .set({
          status: 'succeeded',
          score,
          issue_count: issueCount,
          summary: JSON.stringify(result),
          completed_at: new Date(),
        })
        .where('id', '=', audit.id)
        .execute();
      await trx
        .updateTable('capere.integrations')
        .set({ last_sync_at: new Date(), last_error: null })
        .where('id', '=', task.integration_id!)
        .execute();
      await trx
        .updateTable('capere.scheduled_jobs')
        .set({ enabled: false })
        .where('organization_id', '=', organizationId)
        .where('name', '=', `dataforseo-audit-poll:${task.id}`)
        .execute();
      await this.outbox.publishInTransaction(trx, {
        type: EventType.SeoAuditCompleted,
        organizationId,
        aggregateType: 'technical_audit',
        aggregateId: audit.id,
        payload: { auditId: audit.id, siteUrl: audit.site_url, score, issueCount },
      });
    });
    return { ready: true, auditId: audit.id, score, issueCount };
  }

  async handleWebhook(body: unknown) {
    const payload = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    const task = payload['id'] ?? payload['task_id'];
    if (typeof task !== 'string') return { accepted: true };
    const row = await this.database.db.selectFrom('capere.provider_tasks').select(['organization_id', 'id']).where('provider', '=', 'data_for_seo').where('provider_task_id', '=', task).executeTakeFirst();
    if (!row) return { accepted: true };
    return this.pollAudit(row.organization_id, row.id);
  }

  private score(result: Record<string, unknown>): number {
    const pageMetrics = this.object(result['page_metrics']);
    const value = Number(pageMetrics['onpage_score'] ?? result['onpage_score'] ?? result['score'] ?? 0);
    return Math.max(0, Math.min(100, Math.round(value)));
  }
  private issueCount(result: Record<string, unknown>): number {
    const pageMetrics = this.object(result['page_metrics']);
    const checks = this.object(pageMetrics['checks']);
    const healthySignals = new Set([
      'is_https',
      'canonical',
      'has_html_doctype',
      'seo_friendly_url',
      'seo_friendly_url_dynamic_check',
      'seo_friendly_url_keywords_check',
      'seo_friendly_url_characters_check',
      'seo_friendly_url_relative_length_check',
    ]);
    const pageIssues = Object.entries(checks).reduce((total, [key, value]) => {
      if (healthySignals.has(key)) return total;
      const count = Number(value);
      return total + (Number.isFinite(count) && count > 0 ? count : 0);
    }, 0);
    const domainChecks = this.object(this.object(result['domain_info'])['checks']);
    const missingDomainFiles = ['sitemap', 'robots_txt'].filter((key) => domainChecks[key] === false).length;
    return pageIssues + missingDomainFiles || Number(result['total_issues'] ?? 0);
  }

  private object(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }
}
