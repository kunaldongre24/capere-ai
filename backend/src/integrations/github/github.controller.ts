import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentOrg, CurrentUser, Roles } from '../../auth';
import type { AuthenticatedUser } from '../../auth';
import { AddRepositoryDto, ConnectGithubDto, CreateChangeRequestDto } from './github.dto';
import { GithubService } from './github.service';

@ApiTags('github')
@ApiBearerAuth('supabase-jwt')
@Controller({ path: 'integrations/github', version: '1' })
export class GithubController {
  constructor(private readonly service: GithubService) {}
  @Post('connect') @Roles('owner', 'office_manager', 'capere_admin') connect(
    @CurrentOrg() o: string,
    @Body() d: ConnectGithubDto,
  ) {
    return this.service.connect(o, d);
  }
  @Post('installations/:id/repositories') @Roles('owner', 'office_manager', 'capere_admin') repo(
    @CurrentOrg() o: string,
    @Param('id', ParseUUIDPipe) i: string,
    @Body() d: AddRepositoryDto,
  ) {
    return this.service.addRepository(o, i, d);
  }
  @Post('repositories/:id/analyze')
  @Roles('owner', 'office_manager', 'marketing_manager', 'seo_specialist', 'capere_admin')
  analyze(@CurrentOrg() o: string, @Param('id', ParseUUIDPipe) i: string) {
    return this.service.analyze(o, i);
  }
  @Post('repositories/:id/changes') @Roles('owner', 'office_manager', 'capere_admin') change(
    @CurrentOrg() o: string,
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) i: string,
    @Body() d: CreateChangeRequestDto,
  ) {
    return this.service.createChangeRequest(o, i, u.id, d);
  }
  @Post('changes/:id/approve') @Roles('owner', 'office_manager', 'capere_admin') approve(
    @CurrentOrg() o: string,
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) i: string,
  ) {
    return this.service.approveAndExecute(o, i, u.id);
  }
}
