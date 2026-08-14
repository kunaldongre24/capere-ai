import { IsBoolean, IsInt, IsOptional, IsString, IsUrl, Length, Max, Min } from 'class-validator';

export class CreateSeoProjectDto {
  @IsString() @Length(1, 200) name!: string;
  @IsUrl({ require_protocol: true }) siteUrl!: string;
  @IsInt() @Min(1) targetLocationCode!: number;
  @IsString() @Length(2, 10) languageCode = 'en';
}

export class RunSeoAuditDto {
  @IsInt() @Min(1) @Max(20) maxCrawlPages = 20;
}

export class SetSeoWebsiteDto {
  @IsUrl({ require_protocol: true }) siteUrl!: string;
  @IsOptional() @IsBoolean() confirmChange = false;
}

export class CreateCompetitorDto {
  @IsString() @Length(1, 120) domain!: string;
  @IsString() @Length(1, 200) name!: string;
}
