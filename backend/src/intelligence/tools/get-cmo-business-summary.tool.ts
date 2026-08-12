import { Injectable, OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import type { Tool, ToolContext } from './tool.interface';
import { ToolRegistry } from './tool-registry';
import { GetGa4SummaryTool } from './get-ga4-summary.tool';
import { GetGbpSummaryTool } from './get-gbp-summary.tool';
import { GetGhlPipelineSummaryTool } from './get-ghl-pipeline-summary.tool';
import { GetGscSummaryTool } from './get-gsc-summary.tool';
import { GetSeoProjectSummaryTool } from './get-seo-project-summary.tool';
import { GhlBusinessSnapshotService } from '../../integrations/ghl/ghl-business-snapshot.service';
import { Optional } from '@nestjs/common';

const schema = z.object({
  days: z.number().int().min(1).max(30).default(7),
});

type Input = { days?: number };

@Injectable()
export class GetCmoBusinessSummaryTool implements Tool<Input>, OnModuleInit {
  readonly name = 'get_cmo_business_summary';
  readonly description =
    'Returns a single multi-channel business overview for broad CMO questions. It checks GA4 website traffic, Search Console visibility, the GoHighLevel opportunity pipeline, the SEO project, and Google Business Profile concurrently. Prefer this tool for weekly priorities, growth reviews, or questions spanning more than one channel.';
  readonly schema = schema;
  readonly permissions = ['owner', 'office_manager', 'marketing_manager', 'capere_admin'] as const;
  readonly agents = ['cmo'] as const;
  readonly timeoutMs = 25_000;
  readonly mutates = false;

  constructor(
    private readonly ga4: GetGa4SummaryTool,
    private readonly gsc: GetGscSummaryTool,
    private readonly pipeline: GetGhlPipelineSummaryTool,
    private readonly seo: GetSeoProjectSummaryTool,
    private readonly gbp: GetGbpSummaryTool,
    private readonly registry: ToolRegistry,
    @Optional() private readonly ghlBusiness?: GhlBusinessSnapshotService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async execute(input: Input, context: ToolContext) {
    const days = input.days ?? 7;
    const safe = async (source: string, request: Promise<unknown>) => {
      try {
        return await request;
      } catch (error) {
        return {
          available: false,
          message: `${source} could not be checked: ${error instanceof Error ? error.message : 'unknown error'}`,
        };
      }
    };
    const [ga4, searchConsole, pipeline, seo, googleBusinessProfile, goHighLevelOperations] = await Promise.all([
      safe('Website analytics', this.ga4.execute({ days }, context)),
      safe('Google Search Console', this.gsc.execute({ days }, context)),
      safe('GoHighLevel pipeline', this.pipeline.execute({ maxRecords: 500 }, context)),
      safe('SEO project', this.seo.execute({}, context)),
      safe('Google Business Profile', this.gbp.execute({ days }, context)),
      this.ghlBusiness
        ? safe('GoHighLevel operations', this.ghlBusiness.summary(context.organizationId))
        : Promise.resolve({ available: false, message: 'GoHighLevel operating data is unavailable.' }),
    ]);
    return {
      periodDays: days,
      websiteAnalytics: ga4,
      searchConsole,
      goHighLevelPipeline: pipeline,
      seo,
      googleBusinessProfile,
      goHighLevelOperations,
    };
  }
}
