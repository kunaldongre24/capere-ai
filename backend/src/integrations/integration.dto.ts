import { IsString, Length } from 'class-validator';

export class ConnectGhlDto {
  @IsString()
  @Length(1, 255)
  locationId!: string;

  @IsString()
  @Length(20, 8_192)
  accessToken!: string;
}
