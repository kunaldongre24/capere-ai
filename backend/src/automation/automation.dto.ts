import { IsEnum, IsObject, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import type { AutomationKind } from '../shared/database';
export class CreateAutomationDto {
  @IsUUID() integrationId!: string;
  @IsOptional() @IsUUID() recommendationId?: string;
  @IsEnum(['ghl_task_create', 'ghl_workflow_trigger']) kind!: AutomationKind;
  @IsString() @MaxLength(200) title!: string;
  @IsObject() payload!: Record<string, unknown>;
}
