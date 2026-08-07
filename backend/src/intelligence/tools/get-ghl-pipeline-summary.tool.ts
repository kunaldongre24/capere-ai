import { Injectable, OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { GhlAdapter } from '../../integrations/ghl/ghl.adapter';
import { GhlTokenService } from '../../integrations/ghl/ghl-token.service';
import { DatabaseService } from '../../shared/database';
import type { Tool, ToolContext } from './tool.interface';
import { ToolRegistry } from './tool-registry';

const schema = z.object({
  integrationId: z.string().uuid().optional(),
  maxRecords: z.number().int().min(1).max(1000).default(500),
});
type Input = { integrationId?: string; maxRecords?: number };

interface Opportunity {
  id?: string;
  status?: string;
  monetaryValue?: number;
  pipelineId?: string;
}

interface OpportunityPage {
  opportunities?: Opportunity[];
  meta?: { total?: number; currentPage?: number; nextPage?: number | null };
}

@Injectable()
export class GetGhlPipelineSummaryTool implements Tool<Input>, OnModuleInit {
  readonly name = 'get_ghl_pipeline_summary';
  readonly description =
    'Reads the current GoHighLevel opportunity pipeline without copying CRM entities into Capere.';
  readonly schema = schema;
  readonly permissions = ['owner', 'office_manager', 'marketing_manager', 'capere_admin'] as const;
  readonly agents = ['general', 'analytics', 'cmo'] as const;
  readonly timeoutMs = 20_000;
  readonly mutates = false;
  constructor(
    private readonly database: DatabaseService,
    private readonly tokens: GhlTokenService,
    private readonly ghl: GhlAdapter,
    private readonly registry: ToolRegistry,
  ) {}
  onModuleInit(): void {
    this.registry.register(this);
  }

  async execute(input: Input, context: ToolContext) {
    let query = this.database.db
      .selectFrom('capere.integrations')
      .select(['id', 'account_id', 'account_name'])
      .where('organization_id', '=', context.organizationId)
      .where('provider', '=', 'go_high_level')
      .where('status', '=', 'connected');
    if (input.integrationId) query = query.where('id', '=', input.integrationId);
    const integrations = await query.orderBy('created_at', 'asc').limit(11).execute();
    if (!input.integrationId && integrations.length > 1)
      return {
        connected: true,
        ambiguous: true,
        message: 'Multiple GoHighLevel locations are connected. Choose an integrationId.',
        integrations: integrations.slice(0, 10).map((row) => ({
          integrationId: row.id,
          locationId: row.account_id,
          locationName: row.account_name,
        })),
      };
    const integration = integrations[0];
    if (!integration?.account_id)
      return { connected: false, message: 'GoHighLevel is not connected for this organization.' };
    const credentials = await this.tokens.credentials(context.organizationId, integration.id);
    const maxRecords = input.maxRecords ?? 500;
    const opportunities: Opportunity[] = [];
    let reportedTotal: number | undefined;
    let page = 1;
    while (opportunities.length < maxRecords) {
      const body = await this.ghl.getJson<OpportunityPage>(credentials, 'opportunities/search', {
        location_id: integration.account_id,
        limit: Math.min(100, maxRecords - opportunities.length),
        page,
      });
      const rows = body.opportunities ?? [];
      opportunities.push(...rows);
      reportedTotal ??= body.meta?.total;
      if (
        rows.length === 0 ||
        opportunities.length >= maxRecords ||
        (reportedTotal !== undefined && opportunities.length >= reportedTotal)
      )
        break;
      const nextPage = body.meta?.nextPage;
      if (nextPage === null || (nextPage === undefined && rows.length < 100)) break;
      page = nextPage ?? page + 1;
    }
    const byStatus: Record<string, number> = {};
    const byPipeline: Record<string, number> = {};
    let pipelineValue = 0;
    for (const opportunity of opportunities) {
      const status = opportunity.status ?? 'unknown';
      const pipeline = opportunity.pipelineId ?? 'unknown';
      byStatus[status] = (byStatus[status] ?? 0) + 1;
      byPipeline[pipeline] = (byPipeline[pipeline] ?? 0) + 1;
      pipelineValue += Number(opportunity.monetaryValue ?? 0);
    }
    return {
      connected: true,
      integrationId: integration.id,
      locationId: integration.account_id,
      locationName: integration.account_name,
      returned: opportunities.length,
      total: reportedTotal ?? opportunities.length,
      pipelineValue,
      byStatus,
      byPipeline,
      complete:
        reportedTotal === undefined
          ? opportunities.length < maxRecords
          : opportunities.length >= reportedTotal,
      truncated:
        reportedTotal !== undefined
          ? reportedTotal > opportunities.length
          : opportunities.length >= maxRecords,
      pagesRead: page,
    };
  }
}
