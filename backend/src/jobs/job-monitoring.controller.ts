import { Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentOrg, Roles } from '../auth';
import { JobMonitoringService } from './job-monitoring.service';
@ApiTags('jobs')
@ApiBearerAuth('supabase-jwt')
@Controller({ path: 'jobs', version: '1' })
export class JobMonitoringController {
  constructor(private readonly service: JobMonitoringService) {}
  @Get() @Roles('owner', 'office_manager', 'capere_admin') list(
    @CurrentOrg() o: string,
    @Query('status') s?: 'failed' | 'dead_lettered',
  ) {
    return this.service.list(o, s);
  }
  @Post(':id/retry') @Roles('owner', 'capere_admin') retry(
    @CurrentOrg() o: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.retry(o, id);
  }
}
