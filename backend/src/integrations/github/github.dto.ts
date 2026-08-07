import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ConnectGithubDto {
  @IsString() @Length(1, 64) installationId!: string;
  @IsString() @Length(1, 200) accountLogin!: string;
  @IsString() @Length(1, 50) accountType!: string;
}
export class AddRepositoryDto {
  @IsString() @Length(1, 64) repositoryId!: string;
  @IsString() @Length(1, 200) owner!: string;
  @IsString() @Length(1, 200) name!: string;
  @IsString() @Length(1, 200) defaultBranch!: string;
  @IsBoolean() private!: boolean;
}
export class FileChangeDto {
  @IsString() @Length(1, 500) path!: string;
  @IsString() @Length(0, 1_000_000) content!: string;
}
export class CreateChangeRequestDto {
  @IsString() @Length(1, 200) title!: string;
  @IsOptional() @IsString() @Length(0, 5000) description?: string;
  @IsString() @Length(7, 64) baseSha!: string;
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => FileChangeDto)
  changes!: FileChangeDto[];
}
