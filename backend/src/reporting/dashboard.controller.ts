import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentOrg, Roles } from '../auth';
import { AppException, ErrorCode } from '../shared/http';
import { DashboardService } from './dashboard.service';
import { ContentGenerationService } from './content-generation.service';
import type { DashboardKind } from '../shared/database';
import { GenerateContentDraftDto } from './reporting.dto';

@ApiTags('command-centers')
@ApiBearerAuth('supabase-jwt')
@Controller({ path: 'command-centers', version: '1' })
export class DashboardController {
  constructor(
    private readonly dashboards: DashboardService,
    private readonly content: ContentGenerationService,
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
