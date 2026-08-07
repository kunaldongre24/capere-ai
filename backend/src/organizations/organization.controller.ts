import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentOrg, CurrentUser, Roles, SkipOrganization } from '../auth';
import type { AuthenticatedUser } from '../auth';
import {
  AddOrganizationMemberDto,
  CreateOrganizationDto,
  UpdateOrganizationDto,
  UpdateOrganizationMemberDto,
} from './organization.dto';
import { OrganizationService } from './organization.service';

@ApiTags('organizations')
@ApiBearerAuth('supabase-jwt')
@Controller({ path: 'organizations', version: '1' })
export class OrganizationController {
  constructor(private readonly organizations: OrganizationService) {}

  @Get('mine')
  @SkipOrganization()
  mine(@CurrentUser() user: AuthenticatedUser) {
    return this.organizations.listForUser(user.id);
  }

  @Post()
  @SkipOrganization()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateOrganizationDto) {
    return this.organizations.create(user.id, user.email, dto);
  }

  @Get('me/profile')
  @SkipOrganization()
  async profile(@CurrentUser() user: AuthenticatedUser) {
    await this.organizations.ensureProfile(user.id, user.email);
    return this.organizations.getProfile(user.id);
  }

  @Get('current')
  current(@CurrentOrg() organizationId: string) {
    return this.organizations.get(organizationId);
  }

  @Patch('current')
  @Roles('owner', 'capere_admin')
  update(@CurrentOrg() organizationId: string, @Body() dto: UpdateOrganizationDto) {
    return this.organizations.update(organizationId, dto);
  }

  @Get('current/members')
  members(@CurrentOrg() organizationId: string) {
    return this.organizations.listMembers(organizationId);
  }

  @Post('current/members')
  @Roles('owner', 'capere_admin')
  addMember(
    @CurrentOrg() organizationId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: AddOrganizationMemberDto,
  ) {
    return this.organizations.addMember(organizationId, actor.id, dto);
  }

  @Patch('current/members/:memberId')
  @Roles('owner', 'capere_admin')
  updateMember(
    @CurrentOrg() organizationId: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Body() dto: UpdateOrganizationMemberDto,
  ) {
    return this.organizations.updateMember(organizationId, memberId, dto);
  }

  @Delete('current/members/:memberId')
  @Roles('owner', 'capere_admin')
  removeMember(
    @CurrentOrg() organizationId: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
  ) {
    return this.organizations.removeMember(organizationId, memberId);
  }
}
