import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { ContentGenerationService } from './content-generation.service';

@Module({
  controllers: [DashboardController],
  providers: [DashboardService, ContentGenerationService],
  exports: [DashboardService, ContentGenerationService],
})
export class ReportingModule {}
