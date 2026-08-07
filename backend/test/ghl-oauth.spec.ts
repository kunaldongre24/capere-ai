import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GhlAdapter } from '../src/integrations/ghl/ghl.adapter';
import { GhlOauthService } from '../src/integrations/ghl/ghl-oauth.service';
import type { IntegrationService } from '../src/integrations/integration.service';
import { CryptoService } from '../src/shared/crypto';
import type { DatabaseService } from '../src/shared/database';
import type { AppConfig } from '../src/shared/config';
import {
  cleanup,
  closeDb,
  seedTwoOrganizations,
  serviceDb,
  type Fixture,
} from './helpers/database';

const crypto = new CryptoService({
  auth: { apiKeyHashingSalt: 'test-salt-0123456789abcdef' },
  encryption: { key: Buffer.alloc(32, 9), keyVersion: 1, previousKeys: new Map() },
} as unknown as AppConfig);

function database(): DatabaseService {
  return {
    db: serviceDb(),
    transaction: (fn) => serviceDb().transaction().execute(fn),
  } as DatabaseService;
}

describe('GHL OAuth', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedTwoOrganizations();
  });

  afterEach(async () => {
    await cleanup(fixture);
    vi.restoreAllMocks();
  });

  afterAll(closeDb);

  it('binds an opaque single-use state to the initiating organization', async () => {
    const exchangeCode = vi.fn().mockResolvedValue({
      access_token: 'access',
      refresh_token: 'refresh',
      expires_in: 86_400,
      locationId: 'location-1',
      userType: 'Location',
    });
    const connectGhlOauth = vi.fn().mockResolvedValue({ id: 'integration-1' });
    const adapter = {
      redirectUri: 'https://api.capereai.com/api/v1/integrations/crm/callback',
      scopes: ['locations.readonly', 'contacts.readonly'],
      authorizationUrl: vi.fn((state: string) => `https://provider.test/oauth?state=${state}`),
      exchangeCode,
    } as unknown as GhlAdapter;
    const service = new GhlOauthService(
      database(),
      crypto,
      adapter,
      { connectGhlOauth } as unknown as IntegrationService,
    );

    const authorizationUrl = new URL(
      await service.beginAuthorization(fixture.orgAId, fixture.userAId),
    );
    const state = authorizationUrl.searchParams.get('state');
    expect(state).toBeTruthy();
    const stored = await serviceDb()
      .selectFrom('capere.oauth_states')
      .select(['organization_id', 'state_hash', 'consumed_at'])
      .where('provider', '=', 'go_high_level')
      .where('organization_id', '=', fixture.orgAId)
      .executeTakeFirstOrThrow();
    expect(stored.state_hash).not.toBe(state);
    expect(stored.consumed_at).toBeNull();

    await expect(service.completeAuthorization(state as string, 'code')).resolves.toEqual({
      id: 'integration-1',
    });
    expect(exchangeCode).toHaveBeenCalledWith('code');
    expect(connectGhlOauth).toHaveBeenCalledWith(
      fixture.orgAId,
      expect.objectContaining({ locationId: 'location-1' }),
    );
    await expect(service.completeAuthorization(state as string, 'code')).rejects.toThrow(
      'OAuth state is invalid or expired',
    );
  });

  it('rejects an unknown state before exchanging a provider code', async () => {
    const exchangeCode = vi.fn();
    const service = new GhlOauthService(
      database(),
      crypto,
      {
        redirectUri: 'https://api.capereai.com/api/v1/integrations/crm/callback',
        scopes: [],
        authorizationUrl: vi.fn(),
        exchangeCode,
      } as unknown as GhlAdapter,
      { connectGhlOauth: vi.fn() } as unknown as IntegrationService,
    );
    await expect(service.completeAuthorization('unknown', 'code')).rejects.toThrow(
      'OAuth state is invalid or expired',
    );
    expect(exchangeCode).not.toHaveBeenCalled();
  });
});
