import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentOrg, Public, Roles } from '../../auth';
import { CreateCompetitorDto, CreateSeoProjectDto, RunSeoAuditDto, SetSeoWebsiteDto, UpdateCompetitorDto } from './dataforseo.dto';
import { DataForSeoService } from './dataforseo.service';
import { GhlSeoDashboardProvisioningService } from '../ghl/ghl-seo-dashboard-provisioning.service';

@ApiTags('data-for-seo')
@ApiBearerAuth('supabase-jwt')
@Controller({ path: 'integrations/data-for-seo', version: '1' })
export class DataForSeoController {
  constructor(
    private readonly service: DataForSeoService,
    private readonly seoProvisioning: GhlSeoDashboardProvisioningService,
  ) {}
  @Post('projects')
  @Roles('owner', 'office_manager', 'marketing_manager', 'seo_specialist', 'capere_admin')
  project(@CurrentOrg() org: string, @Body() dto: CreateSeoProjectDto) {
    return this.service.createProject(org, dto);
  }
  @Post('website')
  @Roles('owner', 'office_manager', 'marketing_manager', 'seo_specialist', 'capere_admin')
  website(@CurrentOrg() org: string, @Body() dto: SetSeoWebsiteDto) {
    return this.seoProvisioning.setWebsite(org, dto.siteUrl, dto.confirmChange);
  }
  @Post('projects/:id/audits')
  @Roles('owner', 'office_manager', 'marketing_manager', 'seo_specialist', 'capere_admin')
  audit(
    @CurrentOrg() org: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RunSeoAuditDto,
  ) {
    return this.service.submitAudit(org, id, dto);
  }
  @Post('projects/:id/competitors')
  @Roles('owner', 'office_manager', 'marketing_manager', 'seo_specialist', 'capere_admin')
  addCompetitor(@CurrentOrg() org: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateCompetitorDto) {
    return this.service.addCompetitor(org, id, dto);
  }
  @Get('projects/:id/competitors')
  @Roles('owner', 'office_manager', 'marketing_manager', 'seo_specialist', 'capere_admin')
  listCompetitors(@CurrentOrg() org: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.listCompetitors(org, id);
  }
  @Patch('projects/:id/competitors/:competitorId')
  @Roles('owner', 'office_manager', 'marketing_manager', 'seo_specialist', 'capere_admin')
  updateCompetitor(@CurrentOrg() org: string, @Param('id', ParseUUIDPipe) id: string, @Param('competitorId', ParseUUIDPipe) competitorId: string, @Body() dto: UpdateCompetitorDto) {
    return this.service.updateCompetitor(org, id, competitorId, dto);
  }
  @Post('projects/:id/competitors/refresh')
  @Roles('owner', 'office_manager', 'marketing_manager', 'seo_specialist', 'capere_admin')
  refreshCompetitors(@CurrentOrg() org: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.refreshCompetitors(org, id);
  }
  @Post('projects/:id/keywords/refresh')
  @Roles('owner', 'office_manager', 'marketing_manager', 'seo_specialist', 'capere_admin')
  refreshKeywords(@CurrentOrg() org: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.refreshKeywords(org, id);
  }
  @Delete('projects/:id/competitors/:competitorId')
  @Roles('owner', 'office_manager', 'marketing_manager', 'seo_specialist', 'capere_admin')
  removeCompetitor(@CurrentOrg() org: string, @Param('id', ParseUUIDPipe) id: string, @Param('competitorId', ParseUUIDPipe) competitorId: string) {
    return this.service.removeCompetitor(org, id, competitorId);
  }
  @Post('tasks/:id/poll')
  @Roles('owner', 'office_manager', 'marketing_manager', 'seo_specialist', 'capere_admin')
  poll(@CurrentOrg() org: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.pollAudit(org, id);
  }

  @Post('webhook')
  @Public()
  webhook(@Req() req: { body: unknown }) {
    return this.service.handleWebhook(req.body);
  }

  @Get('webhook')
  @Public()
  webhookGet(@Query() query: Record<string, unknown>) {
    return this.service.handleWebhook(query);
  }
}
