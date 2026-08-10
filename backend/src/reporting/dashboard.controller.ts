import { Body, Controller, Get, Param, ParseIntPipe, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentOrg, CurrentOrgRole, CurrentUser, Roles } from '../auth';
import { GenerateChatResponseUseCase } from '../intelligence';
import { MemoryService } from '../intelligence/memory/memory.service';
import { AppException, ErrorCode } from '../shared/http';
import type { OrgRole } from '../shared/database';
import { DashboardService } from './dashboard.service';
import { ContentGenerationService } from './content-generation.service';
import type { DashboardKind } from '../shared/database';
import { AskCmoDto, GenerateContentDraftDto } from './reporting.dto';

@ApiTags('command-centers')
@ApiBearerAuth('supabase-jwt')
@Controller({ path: 'command-centers', version: '1' })
export class DashboardController {
  constructor(
    private readonly dashboards: DashboardService,
    private readonly content: ContentGenerationService,
    private readonly intelligence: GenerateChatResponseUseCase,
    private readonly memory: MemoryService,
  ) {}

  @Get()
  @Roles('owner', 'office_manager', 'marketing_manager', 'seo_specialist', 'capere_admin')
  kinds() {
    return this.dashboards.kinds();
  }

  @Get('reports/latest')
  @Roles('owner', 'office_manager', 'marketing_manager', 'seo_specialist', 'capere_admin')
  latestReport(@CurrentOrg() organizationId: string) {
    return this.dashboards.latestReport(organizationId);
  }

  @Get('ai-cmo/morning-brief')
  @Roles('owner', 'office_manager', 'marketing_manager', 'capere_admin')
  cmoBrief(@CurrentOrg() organizationId: string) {
    return this.dashboards.cmoBrief(organizationId);
  }

  @Get('ai-cmo/summary')
  @Roles('owner', 'office_manager', 'marketing_manager', 'capere_admin')
  cmoSummary(@CurrentOrg() organizationId: string) {
    return this.dashboards.cmoSummary(organizationId);
  }

  @Get('ai-cmo/conversations')
  @Roles('owner', 'office_manager', 'marketing_manager', 'capere_admin')
  cmoConversations(
    @CurrentOrg() organizationId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.memory.listSessions({ organizationId, userId, agent: 'cmo' });
  }

  @Get('ai-cmo/conversations/:sessionId')
  @Roles('owner', 'office_manager', 'marketing_manager', 'capere_admin')
  cmoConversation(
    @CurrentOrg() organizationId: string,
    @CurrentUser('id') userId: string,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
  ) {
    return this.memory.sessionConversation({ organizationId, userId, sessionId });
  }

  @Post('ai-cmo/ask')
  @Roles('owner', 'office_manager', 'marketing_manager', 'capere_admin')
  async askCmo(
    @CurrentOrg() organizationId: string,
    @CurrentUser('id') userId: string,
    @CurrentOrgRole() role: OrgRole,
    @Body() dto: AskCmoDto,
  ) {
    const result = await this.intelligence.execute({
      organizationId,
      userId,
      sessionOwnerId: userId,
      role,
      capability: 'cmo',
      message: dto.message,
      sessionId: dto.sessionId,
      ephemeral: false,
      maxTokens: 1_200,
    });
    const sourceLabels: Record<string, string> = {
      get_ga4_summary: 'Website analytics',
      get_gsc_summary: 'Google Search Console',
      get_ghl_pipeline_summary: 'GoHighLevel pipeline',
      get_seo_project_summary: 'SEO audit',
      get_gbp_summary: 'Google Business Profile',
    };
    return {
      sessionId: result.sessionId,
      message: result.content,
      sources: [...new Set(result.toolResults.filter((tool) => tool.ok).map((tool) => sourceLabels[tool.toolName] ?? tool.toolName))],
    };
  }

  @Get('seo-command-center/summary')
  @Roles('owner', 'office_manager', 'marketing_manager', 'seo_specialist', 'capere_admin')
  seoSummary(@CurrentOrg() organizationId: string) {
    return this.dashboards.seoCommandCenter(organizationId);
  }

  @Get('ai-cmo/artifacts')
  @Roles('owner', 'office_manager', 'marketing_manager', 'seo_specialist', 'capere_admin')
  artifacts(@CurrentOrg() organizationId: string) {
    return this.dashboards.artifacts(organizationId);
  }

  @Post('content-drafts')
  @Roles('owner', 'office_manager', 'marketing_manager', 'seo_specialist', 'capere_admin')
  contentDraft(@CurrentOrg() organizationId: string, @Body() dto: GenerateContentDraftDto) {
    return this.content.generate(organizationId, dto.request);
  }

  @Get(':dashboard')
  @Roles('owner', 'office_manager', 'marketing_manager', 'seo_specialist', 'capere_admin')
  metrics(
    @CurrentOrg() organizationId: string,
    @Param('dashboard') dashboard: DashboardKind,
    @Query('days', new ParseIntPipe({ optional: true })) days?: number,
  ) {
    if (!this.dashboards.kinds().includes(dashboard))
      throw AppException.badRequest(ErrorCode.VALIDATION_FAILED, 'Unknown dashboard');
    return this.dashboards.query(organizationId, dashboard, Math.min(days ?? 30, 365));
  }
}
