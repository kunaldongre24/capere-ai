import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentOrg, CurrentUser, Public, Roles } from '../../auth';
import type { AuthenticatedUser } from '../../auth/jwt-verifier.service';
import { GhlOauthService } from './ghl-oauth.service';

@ApiTags('crm-integrations')
@ApiBearerAuth('supabase-jwt')
@Controller({ path: 'integrations/crm', version: '1' })
export class GhlOauthController {
  constructor(private readonly oauth: GhlOauthService) {}

  @Get('authorize')
  @Roles('owner', 'office_manager', 'capere_admin')
  async authorize(
    @CurrentOrg() organizationId: string,
    @CurrentUser() user: AuthenticatedUser | undefined,
  ) {
    return { authorizationUrl: await this.oauth.beginAuthorization(organizationId, user?.id) };
  }

  @Get('callback')
  @Public()
  callback(@Query('state') state: string, @Query('code') code: string) {
    return this.oauth.completeAuthorization(state, code);
  }
}
