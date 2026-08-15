import { IsEmail, IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator';

export class MarketingChatRequestDto {
  @IsOptional() @IsUUID() sessionId?: string;
  @IsOptional() @IsString() @Length(32, 128) sessionToken?: string;
  @IsString() @Length(1, 1_200) message!: string;
  @IsOptional() @IsString() @MaxLength(120) website?: string;
}

export class MarketingLeadDto {
  @IsUUID() sessionId!: string;
  @IsString() @Length(32, 128) sessionToken!: string;
  @IsString() @Length(2, 120) name!: string;
  @IsEmail() @MaxLength(254) email!: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsString() @Length(2, 200) firmName!: string;
  @IsOptional() @IsString() @MaxLength(300) website?: string;
}
