import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatMapper } from './chat.mapper';

@Module({
  controllers: [ChatController],
  providers: [ChatMapper],
  exports: [ChatMapper],
})
export class ChatModule {}
