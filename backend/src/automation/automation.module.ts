import { Module } from '@nestjs/common';
import { IntegrationModule } from '../integrations/integration.module';
import { AutomationController } from './automation.controller';
import { AutomationService } from './automation.service';
@Module({
  imports: [IntegrationModule],
  controllers: [AutomationController],
  providers: [AutomationService],
  exports: [AutomationService],
})
export class AutomationModule {}
