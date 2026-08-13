import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { CurrentOrg, CurrentOrgRole, CurrentUser, Public, Roles } from '../auth';
import type { OrgRole } from '../shared/database';
import { AppException, ErrorCode } from '../shared/http';
import { CreateSeoDashboardEmbedDto, ExchangeSeoDashboardEmbedDto } from './seo-dashboard-embed.dto';
import { SeoDashboardEmbedService } from './seo-dashboard-embed.service';

@Controller({path:'dashboard-embeds/seo',version:'1'})
export class SeoDashboardEmbedController {
  constructor(private readonly embeds:SeoDashboardEmbedService){}
  @Get('locations') @Roles('owner','capere_admin') locations(@CurrentOrg() org:string){return this.embeds.locations(org)}
  @Get() @Roles('owner','capere_admin') list(@CurrentOrg() org:string){return this.embeds.list(org)}
  @Post() @Roles('owner','capere_admin') create(@CurrentOrg() org:string,@CurrentUser('id') userId:string,@CurrentOrgRole() role:OrgRole,@Body() dto:CreateSeoDashboardEmbedDto){return this.embeds.create(org,userId,role,dto.ghlLocationId,dto.label)}
  @Post(':id/revoke') @Roles('owner','capere_admin') revoke(@CurrentOrg() org:string,@Param('id',ParseUUIDPipe) id:string){return this.embeds.revoke(org,id)}
  @Post('session') @Public() session(@Body() dto:ExchangeSeoDashboardEmbedDto){return this.embeds.exchange(dto.key)}
  @Get('summary') @Public() summary(@Headers('authorization') authorization?:string){const token=authorization?.match(/^Embed (.+)$/i)?.[1];if(!token)throw AppException.unauthorized(ErrorCode.UNAUTHENTICATED,'Dashboard session is required');return this.embeds.summary(token)}
}
