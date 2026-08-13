import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { ContentGenerationService } from './content-generation.service';
import { IntegrationModule } from '../integrations/integration.module';
import { SeoDashboardEmbedController } from './seo-dashboard-embed.controller';
import { SeoDashboardEmbedService } from './seo-dashboard-embed.service';

@Module({
  imports: [IntegrationModule],
  controllers: [DashboardController, SeoDashboardEmbedController],
  providers: [DashboardService, ContentGenerationService, SeoDashboardEmbedService],
  exports: [DashboardService, ContentGenerationService],
})
export class ReportingModule {}
