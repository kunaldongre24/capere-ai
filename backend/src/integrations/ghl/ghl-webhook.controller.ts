import { Controller, Headers, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../auth';
import type { AuthenticatedRequest } from '../../auth';
import { GhlWebhookService } from './ghl-webhook.service';

interface RawRequest extends AuthenticatedRequest {
  rawBody?: Buffer;
}

@ApiTags('webhooks')
@Controller({ path: ['webhooks/crm', 'webhooks/ghl'], version: '1' })
export class GhlWebhookController {
  constructor(private readonly webhooks: GhlWebhookService) {}
  @Post()
  @Public()
  receive(
    @Req() request: RawRequest,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ) {
    if (!request.rawBody) throw new Error('Raw request body is unavailable');
    return this.webhooks.receive(request.rawBody, headers);
  }
}
