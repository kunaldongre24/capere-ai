import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ExchangeGhlSsoDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(16_384)
  encryptedData!: string;
}

export class CreateFirebaseSessionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(16_384)
  idToken!: string;
}
