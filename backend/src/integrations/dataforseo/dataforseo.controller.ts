import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentOrg, Roles } from '../../auth';
import { CreateSeoProjectDto, RunSeoAuditDto } from './dataforseo.dto';
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
  @Post('tasks/:id/poll')
  @Roles('owner', 'office_manager', 'marketing_manager', 'seo_specialist', 'capere_admin')
  poll(@CurrentOrg() org: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.pollAudit(org, id);
  }
}
