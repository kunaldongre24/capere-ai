import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { ContentGenerationService } from './content-generation.service';
import { IntegrationModule } from '../integrations/integration.module';

@Module({
  imports: [IntegrationModule],
  controllers: [DashboardController],
  providers: [DashboardService, ContentGenerationService],
  exports: [DashboardService, ContentGenerationService],
})
export class ReportingModule {}
