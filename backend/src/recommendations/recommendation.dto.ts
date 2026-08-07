import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import type { RecommendationStatus } from '../shared/database';

export class UpdateRecommendationStatusDto {
  @IsEnum(['approved', 'in_progress', 'completed', 'dismissed', 'expired'])
  status!: RecommendationStatus;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class RecommendationQueryDto {
  @IsOptional()
  @IsEnum(['proposed', 'approved', 'in_progress', 'completed', 'dismissed', 'expired'])
  status?: RecommendationStatus;
}
