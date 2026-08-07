import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type { RagDocumentStatus, RagVisibility } from '../shared/database';

export class CreateRagDocumentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(240)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  description?: string;

  @IsEnum(['shared', 'tenant'])
  visibility!: RagVisibility;
}

export class ListRagDocumentsDto {
  @IsOptional()
  @IsEnum(['shared', 'tenant'])
  visibility?: RagVisibility;

  @IsOptional()
  @IsEnum(['pending', 'processing', 'indexed', 'failed', 'deleting', 'deleted'])
  status?: RagDocumentStatus;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 25;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(0)
  offset = 0;
}

export interface UploadedSourceFile {
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
  readonly buffer: Buffer;
}
