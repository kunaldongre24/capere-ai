import { Module } from '@nestjs/common';
import { IntegrationModule } from '../integrations/integration.module';
import { MarketingChatController } from './marketing-chat.controller';
import { MarketingChatService } from './marketing-chat.service';

@Module({ imports: [IntegrationModule], controllers: [MarketingChatController], providers: [MarketingChatService] })
export class MarketingChatModule {}
