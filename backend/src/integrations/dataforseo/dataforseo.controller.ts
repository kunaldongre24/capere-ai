import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentOrg, Public, Roles } from '../../auth';
import { CreateCompetitorDto, CreateSeoProjectDto, RunSeoAuditDto } from './dataforseo.dto';
import { DataForSeoService } from './dataforseo.service';

@ApiTags('data-for-seo')
@ApiBearerAuth('supabase-jwt')
@Controller({ path: 'integrations/data-for-seo', version: '1' })
export class DataForSeoController {
  constructor(private readonly service: DataForSeoService) {}
  @Post('projects')
  @Roles('owner', 'office_manager', 'marketing_manager', 'seo_specialist', 'capere_admin')
  project(@CurrentOrg() org: string, @Body() dto: CreateSeoProjectDto) {
    return this.service.createProject(org, dto);
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
  @Post('projects/:id/competitors/refresh')
  @Roles('owner', 'office_manager', 'marketing_manager', 'seo_specialist', 'capere_admin')
  refreshCompetitors(@CurrentOrg() org: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.refreshCompetitors(org, id);
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
