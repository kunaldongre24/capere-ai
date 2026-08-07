import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentOrg, CurrentUser, Roles } from '../auth';
import type { AuthenticatedUser } from '../auth';
import { RecommendationService } from './recommendation.service';
import { RecommendationQueryDto, UpdateRecommendationStatusDto } from './recommendation.dto';

@ApiTags('recommendations')
@ApiBearerAuth('supabase-jwt')
@Controller({ path: 'recommendations', version: '1' })
export class RecommendationController {
  constructor(private readonly recommendations: RecommendationService) {}

  @Get()
  @Roles('owner', 'office_manager', 'marketing_manager', 'seo_specialist', 'capere_admin')
  list(@CurrentOrg() organizationId: string, @Query() query: RecommendationQueryDto) {
    return this.recommendations.list(organizationId, query.status);
  }

  @Get(':id/history')
  @Roles('owner', 'office_manager', 'marketing_manager', 'seo_specialist', 'capere_admin')
  history(@CurrentOrg() organizationId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.recommendations.history(organizationId, id);
  }

  @Patch(':id/status')
  @Roles('owner', 'office_manager', 'marketing_manager', 'seo_specialist', 'capere_admin')
  transition(
    @CurrentOrg() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRecommendationStatusDto,
  ) {
    return this.recommendations.transition(organizationId, id, dto.status, user.id, dto.reason);
  }
}
