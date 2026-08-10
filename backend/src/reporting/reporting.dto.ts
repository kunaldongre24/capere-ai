import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class GenerateContentDraftDto {
  @IsOptional()
  @IsString()
  @MinLength(10)
  @MaxLength(2_000)
  request?: string;
}

export class AskCmoDto {
  @IsString()
  @MinLength(2)
  @MaxLength(2_000)
  message!: string;

  @IsOptional()
  @IsUUID()
  sessionId?: string;
}
