import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../../shared/database';
import { EventType, OutboxService } from '../../shared/events';
import { AppException, ErrorCode } from '../../shared/http';
import { DataForSeoAdapter } from './dataforseo.adapter';
import type { CreateSeoProjectDto, RunSeoAuditDto } from './dataforseo.dto';

@Injectable()
export class DataForSeoService {
  constructor(
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

  async createProject(organizationId: string, dto: CreateSeoProjectDto) {
    await this.ensurePlatformIntegration(organizationId);
    return this.database.db
      .insertInto('capere.seo_projects')
      .values({
        organization_id: organizationId,
        name: dto.name,
        site_url: dto.siteUrl,
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
      max_crawl_pages: dto.maxCrawlPages,
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

  private score(result: Record<string, unknown>): number {
    const value = Number(result['onpage_score'] ?? result['score'] ?? 0);
    return Math.max(0, Math.min(100, Math.round(value)));
  }
  private issueCount(result: Record<string, unknown>): number {
    const checks = result['checks'];
    return checks && typeof checks === 'object'
      ? Object.values(checks).filter(Boolean).length
      : Number(result['total_issues'] ?? 0);
  }
}
