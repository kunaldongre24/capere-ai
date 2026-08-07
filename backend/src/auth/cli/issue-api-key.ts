#!/usr/bin/env tsx
import * as path from 'node:path';
import * as dotenv from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../app.module';
import type { OrgRole } from '../../shared/database';
import { ApiKeyService } from '../api-key.service';

dotenv.config({ path: path.resolve(__dirname, '../../../../.env'), override: false });

const VALID_ROLES = new Set<OrgRole>([
  'owner',
  'office_manager',
  'marketing_manager',
  'seo_specialist',
  'capere_admin',
]);

const organizationId = process.argv[2];
const name = process.argv[3]?.trim() || 'Open WebUI';
const roleNames = (process.argv[4] ?? 'office_manager')
  .split(',')
  .map((role) => role.trim())
  .filter(Boolean);

if (!organizationId) {
  console.error('Usage: pnpm api-key:issue <organization-id> [name] [comma-separated-roles]');
  process.exitCode = 1;
} else if (roleNames.length === 0 || roleNames.some((role) => !VALID_ROLES.has(role as OrgRole))) {
  console.error(`Roles must be one or more of: ${Array.from(VALID_ROLES).join(', ')}`);
  process.exitCode = 1;
} else {
  void main(organizationId, name, roleNames as OrgRole[]);
}

async function main(
  targetOrganizationId: string,
  keyName: string,
  roles: OrgRole[],
): Promise<void> {
  let app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>> | undefined;

  try {
    app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    const keys = app.get(ApiKeyService);
    const issued = await keys.issue({
      organizationId: targetOrganizationId,
      name: keyName,
      roles,
      issuerRole: 'capere_admin',
    });

    console.warn(`API key ${issued.id} issued (${issued.prefix}…).`);
    console.warn('Copy this value now; it will not be shown again:');
    console.warn(issued.rawKey);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to issue API key: ${message}`);
    process.exitCode = 1;
  } finally {
    await app?.close();
  }
}
