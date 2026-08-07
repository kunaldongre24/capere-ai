import { IsIn, IsString, Length, IsOptional, IsUrl } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ConnectGoogleResourceDto {
  @IsIn(['google_analytics_4', 'google_search_console', 'google_business_profile'])
  provider!: 'google_analytics_4' | 'google_search_console' | 'google_business_profile';

  @IsString()
  @Length(1, 512)
  resourceId!: string;

  @IsOptional()
  @IsString()
  @Length(1, 512)
  resourceName?: string;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  siteUrl?: string;

  @IsOptional()
  @IsString()
  @Length(1, 512)
  parentAccount?: string;
}

export class GoogleGa4ResourceDto {
  @ApiProperty({ example: 'properties/123456789' })
  id?: string;

  @ApiProperty({ example: 'Capere AI' })
  name?: string;
}

export class GoogleGscResourceDto {
  @ApiProperty({ example: 'sc-domain:capereai.com' })
  id?: string;

  @ApiProperty({ example: 'sc-domain:capereai.com' })
  name?: string;

  @ApiPropertyOptional({ example: 'siteOwner' })
  permission?: string;
}

export class GoogleGbpResourceDto {
  @ApiPropertyOptional({ example: 'locations/123456789' })
  id?: string;

  @ApiPropertyOptional({ example: 'Capere CPA' })
  name?: string;

  @ApiPropertyOptional({ example: 'Capere CPA Group' })
  account?: string;

  @ApiPropertyOptional({ example: 'accounts/123456789' })
  parentAccount?: string;
}

export class GoogleDiscoveryWarningDto {
  @ApiProperty({ enum: ['ga4', 'gsc', 'gbp'] })
  provider!: 'ga4' | 'gsc' | 'gbp';

  @ApiProperty({
    enum: ['FORBIDDEN', 'RATE_LIMITED', 'TIMEOUT', 'UNAVAILABLE'],
    example: 'RATE_LIMITED',
  })
  code!: 'FORBIDDEN' | 'RATE_LIMITED' | 'TIMEOUT' | 'UNAVAILABLE';

  @ApiProperty({ example: 'GBP resource discovery is temporarily unavailable' })
  message!: string;

  @ApiPropertyOptional({ example: 'accounts/123456789' })
  resourceId?: string;

  @ApiPropertyOptional({ example: 60000 })
  retryAfterMs?: number;
}

export class GoogleDiscoveryResponseDto {
  @ApiProperty({ type: [GoogleGa4ResourceDto] })
  ga4!: GoogleGa4ResourceDto[];

  @ApiProperty({ type: [GoogleGscResourceDto] })
  gsc!: GoogleGscResourceDto[];

  @ApiProperty({ type: [GoogleGbpResourceDto] })
  gbp!: GoogleGbpResourceDto[];

  @ApiProperty({ type: [GoogleDiscoveryWarningDto] })
  warnings!: GoogleDiscoveryWarningDto[];
}
