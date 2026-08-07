import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class GenerateContentDraftDto {
  @IsOptional()
  @IsString()
  @MinLength(10)
  @MaxLength(2_000)
  request?: string;
}
