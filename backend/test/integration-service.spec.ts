import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntegrationService } from '../src/integrations/integration.service';
import type { GhlAdapter } from '../src/integrations/ghl/ghl.adapter';
import { CryptoService } from '../src/shared/crypto';
import type { DatabaseService } from '../src/shared/database';
import { OutboxService } from '../src/shared/events/outbox.service';
import type { AppConfig } from '../src/shared/config';
import {
  cleanup,
  closeDb,
  seedTwoOrganizations,
  serviceDb,
  type Fixture,
} from './helpers/database';

// A structural stand-in: CryptoService only reads `auth` and `encryption`, so
// building a full AppConfig here would be noise. The double cast is required
// because the partial deliberately does not overlap AppConfig — the same
// pattern the other service specs use.
const crypto = new CryptoService({
  auth: { apiKeyHashingSalt: 'test-salt-0123456789abcdef' },
  encryption: {
    key: Buffer.alloc(32, 7),
    keyVersion: 1,
    previousKeys: new Map(),
  },
} as unknown as AppConfig);

function databaseService(): DatabaseService {
  return {
    db: serviceDb(),
    transaction: (fn) => serviceDb().transaction().execute(fn),
  } as DatabaseService;
}

describe('IntegrationService', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedTwoOrganizations();
  });

  afterEach(async () => {
    await cleanup(fixture);
    vi.restoreAllMocks();
  });

  afterAll(closeDb);

  it('serializes concurrent GHL connections and keeps credential AAD bound to the stored id', async () => {
    const database = databaseService();
    const ghl = {
      getLocation: vi.fn().mockResolvedValue({
        id: 'ghl-location-1',
        name: 'CPA Firm',
        timezone: 'America/New_York',
      }),
    } as unknown as GhlAdapter;
    const service = new IntegrationService(database, crypto, new OutboxService(database), ghl);

    const [first, second] = await Promise.all([
      service.connectGhl(fixture.orgAId, {
        locationId: 'ghl-location-1',
        accessToken: 'first-access-token-value',
      }),
      service.connectGhl(fixture.orgAId, {
        locationId: 'ghl-location-1',
        accessToken: 'second-access-token-value',
      }),
    ]);

    expect(first.id).toBe(second.id);
    const rows = await serviceDb()
      .selectFrom('capere.integrations')
      .select(['id', 'encrypted_credentials'])
      .where('organization_id', '=', fixture.orgAId)
      .where('provider', '=', 'go_high_level')
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].encrypted_credentials).not.toBeNull();
    expect(() =>
      crypto.decryptJson(rows[0].encrypted_credentials as Buffer, `integration:${rows[0].id}`),
    ).not.toThrow();
  });
});
