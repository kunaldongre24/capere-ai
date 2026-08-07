import { IsEnum, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';
import type { OrgRole } from '../shared/database';

const MANAGEABLE_ROLES = [
  'owner',
  'office_manager',
  'marketing_manager',
  'seo_specialist',
] as const;

export class UpdateOrganizationDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9-]{1,62}$/)
  slug?: string;
}

export class CreateOrganizationDto {
  @IsString()
  @Length(1, 200)
  name!: string;

  @IsString()
  @Matches(/^[a-z0-9][a-z0-9-]{1,62}$/)
  slug!: string;
}

export class AddOrganizationMemberDto {
  @IsUUID()
  userId!: string;

  @IsEnum(MANAGEABLE_ROLES)
  role!: Exclude<OrgRole, 'capere_admin'>;
}

export class UpdateOrganizationMemberDto {
  @IsEnum(MANAGEABLE_ROLES)
  role!: Exclude<OrgRole, 'capere_admin'>;
}
