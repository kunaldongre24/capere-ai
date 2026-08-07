import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentOrg, CurrentUser, Roles } from '../auth';
import type { AuthenticatedUser } from '../auth';
import { CreateAutomationDto } from './automation.dto';
import { AutomationService } from './automation.service';
@ApiTags('automation')
@ApiBearerAuth('supabase-jwt')
@Controller({ path: 'automation', version: '1' })
export class AutomationController {
  constructor(private readonly service: AutomationService) {}
  @Get() @Roles('owner', 'office_manager', 'marketing_manager', 'capere_admin') list(
    @CurrentOrg() o: string,
  ) {
    return this.service.list(o);
  }
  @Post() @Roles('owner', 'office_manager', 'marketing_manager', 'capere_admin') create(
    @CurrentOrg() o: string,
    @CurrentUser() u: AuthenticatedUser,
    @Body() d: CreateAutomationDto,
  ) {
    return this.service.create(o, u.id, d);
  }
  @Post(':id/approve') @Roles('owner', 'office_manager', 'capere_admin') approve(
    @CurrentOrg() o: string,
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.approve(o, id, u.id);
  }
}
