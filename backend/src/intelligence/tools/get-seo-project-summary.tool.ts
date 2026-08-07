import { Injectable, OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../../shared/database';
import type { Tool, ToolContext } from './tool.interface';
import { ToolRegistry } from './tool-registry';

const schema = z.object({ projectId: z.string().uuid().optional() });
type Input = { projectId?: string };

@Injectable()
export class GetSeoProjectSummaryTool implements Tool<Input>, OnModuleInit {
  readonly name = 'get_seo_project_summary';
  readonly description =
    'Returns a grounded SEO project snapshot with latest keyword rankings, technical audit, and competitors.';
  readonly schema = schema;
  readonly permissions = [
    'owner',
    'office_manager',
    'marketing_manager',
    'seo_specialist',
    'capere_admin',
  ] as const;
  readonly agents = ['general', 'seo', 'cmo', 'content'] as const;
  readonly timeoutMs = 10_000;
  readonly mutates = false;
  constructor(
    private readonly database: DatabaseService,
    private readonly registry: ToolRegistry,
  ) {}
  onModuleInit(): void {
    this.registry.register(this);
  }

  async execute(input: Input, context: ToolContext) {
    let projectQuery = this.database.db
      .selectFrom('capere.seo_projects')
      .selectAll()
      .where('organization_id', '=', context.organizationId)
      .where('enabled', '=', true);
    if (input.projectId) projectQuery = projectQuery.where('id', '=', input.projectId);
    const projects = await projectQuery.orderBy('created_at', 'asc').limit(11).execute();
    if (!input.projectId && projects.length > 1)
      return {
        available: true,
        ambiguous: true,
        message: 'Multiple SEO projects are enabled. Choose a projectId.',
        projects: projects.slice(0, 10).map((row) => ({
          projectId: row.id,
          name: row.name,
          siteUrl: row.site_url,
        })),
      };
    const project = projects[0];
    if (!project) return { available: false, message: 'No enabled SEO project was found.' };
    const [keywords, audit, competitors] = await Promise.all([
      this.database.db
        .selectFrom('capere.keywords as k')
        .leftJoin('capere.keyword_rankings as r', 'r.keyword_id', 'k.id')
        .distinctOn('k.id')
        .select(['k.id', 'k.keyword', 'k.tags', 'r.checked_on', 'r.rank', 'r.url'])
        .where('k.organization_id', '=', context.organizationId)
        .where('k.seo_project_id', '=', project.id)
        .where('k.enabled', '=', true)
        .orderBy('k.id')
        .orderBy('r.checked_on', 'desc')
        .limit(100)
        .execute(),
      this.database.db
        .selectFrom('capere.technical_audits')
        .select(['id', 'status', 'score', 'issue_count', 'summary', 'completed_at'])
        .where('organization_id', '=', context.organizationId)
        .where('seo_project_id', '=', project.id)
        .orderBy('created_at', 'desc')
        .executeTakeFirst(),
      this.database.db
        .selectFrom('capere.competitors')
        .select(['domain', 'name', 'metrics', 'last_checked_at'])
        .where('organization_id', '=', context.organizationId)
        .where('seo_project_id', '=', project.id)
        .orderBy('domain')
        .limit(25)
        .execute(),
    ]);
    return {
      available: true,
      project: {
        id: project.id,
        name: project.name,
        siteUrl: project.site_url,
        languageCode: project.language_code,
        targetLocationCode: project.target_location_code,
      },
      keywords: keywords.map((row) => ({
        keyword: row.keyword,
        tags: row.tags,
        checkedOn: row.checked_on,
        rank: row.rank,
        url: row.url,
      })),
      technicalAudit: audit
        ? {
            id: audit.id,
            status: audit.status,
            score: audit.score,
            issueCount: audit.issue_count,
            completedAt: audit.completed_at,
            evidence: this.boundedEvidence(audit.summary),
          }
        : null,
      competitors: competitors.map((row) => ({
        domain: row.domain,
        name: row.name,
        metrics: this.boundedEvidence(row.metrics),
        lastCheckedAt: row.last_checked_at,
      })),
    };
  }

  private boundedEvidence(value: unknown): Record<string, string | number | boolean | null> {
    const object = this.object(value);
    return Object.fromEntries(
      Object.entries(object)
        .filter((entry): entry is [string, string | number | boolean | null] => {
          const candidate = entry[1];
          return candidate === null || ['string', 'number', 'boolean'].includes(typeof candidate);
        })
        .slice(0, 20)
        .map(([key, candidate]) => [
          key.slice(0, 80),
          typeof candidate === 'string' ? candidate.slice(0, 500) : candidate,
        ]),
    );
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
}
