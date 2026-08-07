import { Controller, Get, Post, Query, Body } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentOrg, CurrentUser, Public, Roles } from '../../auth';
import type { AuthenticatedUser } from '../../auth/jwt-verifier.service';
import { ConnectGoogleResourceDto, GoogleDiscoveryResponseDto } from './google.dto';
import { GoogleService } from './google.service';
import { GoogleSyncService } from './google-sync.service';

@ApiTags('google-integrations')
@ApiBearerAuth('supabase-jwt')
@Controller({ path: 'integrations/google', version: '1' })
export class GoogleController {
  constructor(
    private readonly google: GoogleService,
    private readonly syncs: GoogleSyncService,
  ) {}

  @Get('authorize')
  @Roles('owner', 'office_manager', 'capere_admin')
  async authorize(
    @CurrentOrg() organizationId: string,
    @CurrentUser() user: AuthenticatedUser | undefined,
  ) {
    return { authorizationUrl: await this.google.beginAuthorization(organizationId, user?.id) };
  }

  @Get('callback')
  @Public()
  async callback(@Query('state') state: string, @Query('code') code: string) {
    return this.google.completeAuthorization(state, code);
  }

  @Post('resources')
  @Roles('owner', 'office_manager', 'capere_admin')
  connect(
    @CurrentOrg() organizationId: string,
    @Query('authorizationId') authorizationId: string,
    @Body() dto: ConnectGoogleResourceDto,
  ) {
    return this.google.connectResource(organizationId, authorizationId, dto);
  }

  @Get('resources')
  list(@CurrentOrg() organizationId: string, @Query('authorizationId') authorizationId: string) {
    return this.google.listResources(organizationId, authorizationId);
  }

  @Get('available-resources')
  @ApiOkResponse({ type: GoogleDiscoveryResponseDto })
  @Roles('owner', 'office_manager', 'marketing_manager', 'seo_specialist', 'capere_admin')
  discover(
    @CurrentOrg() organizationId: string,
    @Query('authorizationId') authorizationId: string,
  ) {
    return this.google.discoverResources(organizationId, authorizationId);
  }

  @Post('sync')
  @Roles('owner', 'office_manager', 'marketing_manager', 'seo_specialist', 'capere_admin')
  sync(@CurrentOrg() organizationId: string, @Query('integrationId') integrationId: string) {
    return this.syncs.sync(organizationId, integrationId);
  }
}
