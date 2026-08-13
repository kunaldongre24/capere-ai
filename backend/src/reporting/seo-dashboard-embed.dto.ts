import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateSeoDashboardEmbedDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  ghlLocationId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  label?: string;
}

export class ExchangeSeoDashboardEmbedDto {
  @IsString()
  @MinLength(20)
  @MaxLength(200)
  key!: string;
}
