import { Body, Controller, Get, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../auth';
import { MarketingChatRequestDto, MarketingLeadDto } from './marketing-chat.dto';
import { MarketingChatService } from './marketing-chat.service';

@Public()
@Controller({ path: 'public/marketing-chat', version: '1' })
export class MarketingChatController {
  constructor(private readonly service: MarketingChatService) {}
  @Get('config') config() { return this.service.publicConfig(); }
  @Post('sessions') @Throttle({ short: { limit: 3, ttl: 60_000 }, medium: { limit: 20, ttl: 3_600_000 } }) session(@Body('website') website?: string) { return this.service.startSession(website); }
  @Post() @Throttle({ short: { limit: 3, ttl: 60_000 }, medium: { limit: 20, ttl: 3_600_000 } }) chat(@Body() dto: MarketingChatRequestDto) { return this.service.chat(dto); }
  @Post('leads') @Throttle({ short: { limit: 2, ttl: 60_000 }, medium: { limit: 8, ttl: 3_600_000 } }) lead(@Body() dto: MarketingLeadDto) { return this.service.captureLead(dto); }
}
