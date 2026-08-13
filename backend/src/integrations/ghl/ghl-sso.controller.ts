import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../auth';
import { CreateFirebaseSessionDto, ExchangeGhlSsoDto } from './ghl-sso.dto';
import { GhlSsoService } from './ghl-sso.service';

@ApiTags('authentication')
@Controller({ path: 'auth/ghl-sso', version: '1' })
export class GhlSsoController {
  constructor(private readonly sso: GhlSsoService) {}

  @Post('exchange')
  @Public()
  exchange(@Body() body: ExchangeGhlSsoDto) {
    return this.sso.exchange(body.encryptedData);
  }

  @Post('session')
  @Public()
  createSession(@Body() body: CreateFirebaseSessionDto) {
    return this.sso.createFirebaseSession(body.idToken);
  }
}
