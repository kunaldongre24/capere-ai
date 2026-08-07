import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GhlAdapter } from '../src/integrations/ghl/ghl.adapter';
import { GhlTokenService } from '../src/integrations/ghl/ghl-token.service';
import { CryptoService } from '../src/shared/crypto';
import type { AppConfig } from '../src/shared/config';
import type { DatabaseService } from '../src/shared/database';
import {
  cleanup,
  closeDb,
  seedTwoOrganizations,
  serviceDb,
  type Fixture,
} from './helpers/database';

const crypto = new CryptoService({
  auth: { apiKeyHashingSalt: 'test-salt-0123456789abcdef' },
  encryption: { key: Buffer.alloc(32, 11), keyVersion: 1, previousKeys: new Map() },
} as unknown as AppConfig);

function database(): DatabaseService {
  return {
    db: serviceDb(),
    transaction: (fn) => serviceDb().transaction().execute(fn),
  } as DatabaseService;
}

describe('GHL token lifecycle', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedTwoOrganizations();
  });

  afterEach(async () => {
    await cleanup(fixture);
    vi.restoreAllMocks();
  });

  afterAll(closeDb);

  it('serializes concurrent refreshes and stores the rotated refresh token', async () => {
    const integrationId = randomUUID();
    await serviceDb()
      .insertInto('capere.integrations')
      .values({
        id: integrationId,
        organization_id: fixture.orgAId,
        provider: 'go_high_level',
        account_id: 'location-1',
        status: 'connected',
        encrypted_credentials: crypto.encryptJson(
          { accessToken: 'expired', refreshToken: 'refresh-1', userType: 'Location' },
          `integration:${integrationId}`,
        ),
        key_version: crypto.keyVersion,
        expires_at: new Date(Date.now() - 60_000),
      })
      .execute();
    const refreshToken = vi.fn().mockResolvedValue({
      access_token: 'access-2',
      refresh_token: 'refresh-2',
      expires_in: 86_400,
      userType: 'Location',
    });
    const service = new GhlTokenService(
      database(),
      crypto,
      { refreshToken } as unknown as GhlAdapter,
    );

    const [first, second] = await Promise.all([
      service.credentials(fixture.orgAId, integrationId),
      service.credentials(fixture.orgAId, integrationId),
    ]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2' });
    expect(refreshToken).toHaveBeenCalledTimes(1);
    const stored = await serviceDb()
      .selectFrom('capere.integrations')
      .select(['encrypted_credentials', 'expires_at'])
      .where('id', '=', integrationId)
      .executeTakeFirstOrThrow();
    expect(stored.expires_at?.getTime()).toBeGreaterThan(Date.now());
    expect(
      crypto.decryptJson(stored.encrypted_credentials as Buffer, `integration:${integrationId}`),
    ).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2' });
  });

  it('never returns another tenant organization’s credentials', async () => {
    const integrationId = randomUUID();
    await serviceDb()
      .insertInto('capere.integrations')
      .values({
        id: integrationId,
        organization_id: fixture.orgAId,
        provider: 'go_high_level',
        account_id: 'location-1',
        status: 'connected',
        encrypted_credentials: crypto.encryptJson(
          { accessToken: 'secret' },
          `integration:${integrationId}`,
        ),
        key_version: crypto.keyVersion,
      })
      .execute();
    const service = new GhlTokenService(database(), crypto, {} as GhlAdapter);
    await expect(service.credentials(fixture.orgBId, integrationId)).rejects.toThrow(
      'GoHighLevel integration not found',
    );
  });
});
