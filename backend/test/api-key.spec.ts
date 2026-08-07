import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiKeyService } from '../src/auth/api-key.service';
import type { AppConfig } from '../src/shared/config';
import { CryptoService } from '../src/shared/crypto';
import type { DatabaseService, OrgRole } from '../src/shared/database';
import {
  cleanup,
  closeDb,
  seedTwoOrganizations,
  serviceDb,
  type Fixture,
} from './helpers/database';

function cryptoService(): CryptoService {
  return new CryptoService({
    auth: { apiKeyHashingSalt: 'api-key-test-salt-0123456789' },
    encryption: {
      key: Buffer.alloc(32, 1),
      keyVersion: 1,
      previousKeys: new Map(),
    },
  } as unknown as AppConfig);
}

describe('ApiKeyService', () => {
  let fixture: Fixture;
  let service: ApiKeyService;

  beforeAll(async () => {
    fixture = await seedTwoOrganizations();
    service = new ApiKeyService({ db: serviceDb() } as DatabaseService, cryptoService());
  });

  beforeEach(async () => {
    await serviceDb()
      .deleteFrom('capere.api_keys')
      .where('organization_id', 'in', [fixture.orgAId, fixture.orgBId])
      .execute();
    await serviceDb()
      .updateTable('capere.organizations')
      .set({ status: 'active' })
      .where('id', 'in', [fixture.orgAId, fixture.orgBId])
      .execute();
  });

  afterAll(async () => {
    await cleanup(fixture);
    await closeDb();
  });

  it('issues and verifies an organization-bound key for an active organization', async () => {
    const issued = await service.issue({
      organizationId: fixture.orgAId,
      name: 'Open WebUI',
      roles: ['office_manager'],
      issuerRole: 'capere_admin',
    });

    await expect(service.verify(issued.rawKey)).resolves.toMatchObject({
      apiKeyId: issued.id,
      organizationId: fixture.orgAId,
      roles: ['office_manager'],
    });

    const stored = await serviceDb()
      .selectFrom('capere.api_keys')
      .select(['key_hash', 'key_prefix'])
      .where('id', '=', issued.id)
      .executeTakeFirstOrThrow();
    expect(stored.key_hash).not.toContain(issued.rawKey);
    expect(stored.key_prefix).toBe(issued.prefix);
  });

  it.each(['suspended', 'cancelled'] as const)(
    'rejects a valid key after its organization becomes %s',
    async (status) => {
      const issued = await issue(['office_manager']);
      await serviceDb()
        .updateTable('capere.organizations')
        .set({ status })
        .where('id', '=', fixture.orgAId)
        .execute();

      await expect(service.verify(issued.rawKey)).rejects.toMatchObject({ status: 403 });
    },
  );

  it.each(['suspended', 'cancelled'] as const)(
    'does not issue keys for a %s organization',
    async (status) => {
      await serviceDb()
        .updateTable('capere.organizations')
        .set({ status })
        .where('id', '=', fixture.orgAId)
        .execute();

      await expect(issue(['office_manager'])).rejects.toMatchObject({ status: 403 });
    },
  );

  it('rejects revoked keys', async () => {
    const issued = await issue(['office_manager']);
    await service.revoke(issued.id, fixture.orgAId);
    await expect(service.verify(issued.rawKey)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects expired keys', async () => {
    const issued = await service.issue({
      organizationId: fixture.orgAId,
      name: 'Expired',
      roles: ['office_manager'],
      issuerRole: 'capere_admin',
      expiresAt: new Date(Date.now() - 60_000),
    });
    await expect(service.verify(issued.rawKey)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects persisted keys with no roles', async () => {
    const rawKey = `cap_${randomUUID().replaceAll('-', '').slice(0, 40)}`;
    const crypto = cryptoService();
    await serviceDb()
      .insertInto('capere.api_keys')
      .values({
        organization_id: fixture.orgAId,
        name: 'Roleless',
        key_prefix: rawKey.slice(0, 12),
        key_hash: crypto.hashApiKey(rawKey),
        roles: [],
      })
      .execute();

    await expect(service.verify(rawKey)).rejects.toMatchObject({ status: 403 });
  });

  it('rejects missing organizations, empty roles, unknown roles, and privilege escalation', async () => {
    await expect(
      service.issue({
        organizationId: randomUUID(),
        name: 'Missing org',
        roles: ['office_manager'],
        issuerRole: 'capere_admin',
      }),
    ).rejects.toMatchObject({ status: 404 });

    await expect(issue([])).rejects.toMatchObject({ status: 400 });
    await expect(issue(['unknown' as OrgRole])).rejects.toMatchObject({ status: 400 });
    await expect(
      service.issue({
        organizationId: fixture.orgAId,
        name: 'Escalating',
        roles: ['owner'],
        issuerRole: 'office_manager',
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  function issue(roles: OrgRole[]) {
    return service.issue({
      organizationId: fixture.orgAId,
      name: 'Test key',
      roles,
      issuerRole: 'capere_admin',
    });
  }
});
