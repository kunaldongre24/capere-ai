import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentOrg, Roles } from '../auth';
import { ConnectGhlDto } from './integration.dto';
import { IntegrationService } from './integration.service';

@ApiTags('integrations')
@ApiBearerAuth('supabase-jwt')
@Controller({ path: 'integrations', version: '1' })
export class IntegrationController {
  constructor(private readonly integrations: IntegrationService) {}

  @Get()
  list(@CurrentOrg() organizationId: string) {
    return this.integrations.list(organizationId);
  }

  @Post('ghl/connect')
  @Roles('owner', 'office_manager', 'capere_admin')
  connectGhl(@CurrentOrg() organizationId: string, @Body() dto: ConnectGhlDto) {
    return this.integrations.connectGhl(organizationId, dto);
  }

  @Delete(':id')
  @Roles('owner', 'office_manager', 'capere_admin')
  disconnect(@CurrentOrg() organizationId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.integrations.disconnect(organizationId, id);
  }
}
