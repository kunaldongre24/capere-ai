import { describe, expect, it, vi } from 'vitest';
import { GoogleService } from '../src/integrations/google/google.service';
import type { GoogleAdapter } from '../src/integrations/google/google.adapter';
import type { GoogleTokenService } from '../src/integrations/google/google-token.service';
import { ProviderAdapterError } from '../src/integrations/provider-adapter';
import type { CryptoService } from '../src/shared/crypto';
import type { DatabaseService } from '../src/shared/database';
import type { OutboxService } from '../src/shared/events';

function serviceWith(getJson: GoogleAdapter['getJson']) {
  const google = { getJson } as GoogleAdapter;
  const tokens = {
    accessToken: vi.fn().mockResolvedValue('google-access-token'),
  } as unknown as GoogleTokenService;
  return new GoogleService(
    {} as DatabaseService,
    {} as CryptoService,
    google,
    {} as OutboxService,
    tokens,
  );
}

describe('GoogleService resource discovery', () => {
  it('returns GA4 and GSC resources when GBP is rate limited', async () => {
    const getJson = vi.fn(async (url: string) => {
      if (url.includes('analyticsadmin')) {
        return {
          accountSummaries: [
            { propertySummaries: [{ property: 'properties/123', displayName: 'Capere GA4' }] },
          ],
        };
      }
      if (url.includes('webmasters')) {
        return {
          siteEntry: [{ siteUrl: 'sc-domain:capereai.com', permissionLevel: 'siteOwner' }],
        };
      }
      throw new ProviderAdapterError('google', 'google returned HTTP 429', 'rate_limited', 429);
    }) as GoogleAdapter['getJson'];

    const result = await serviceWith(getJson).discoverResources('org-1', 'authorization-1');

    expect(result).toEqual({
      ga4: [{ id: 'properties/123', name: 'Capere GA4' }],
      gsc: [
        {
          id: 'sc-domain:capereai.com',
          name: 'sc-domain:capereai.com',
          permission: 'siteOwner',
        },
      ],
      gbp: [],
      warnings: [
        {
          provider: 'gbp',
          code: 'RATE_LIMITED',
          message: 'GBP resource discovery is temporarily unavailable',
        },
      ],
    });
  });

  it('does not hide unexpected discovery defects', async () => {
    const getJson = vi.fn(async () => {
      throw new TypeError('unexpected response handling defect');
    }) as GoogleAdapter['getJson'];

    await expect(
      serviceWith(getJson).discoverResources('org-1', 'authorization-1'),
    ).rejects.toThrow('unexpected response handling defect');
  });

  it('requires reconnection when Google rejects the shared access token', async () => {
    const getJson = vi.fn(async () => {
      throw new ProviderAdapterError('google', 'google returned HTTP 401', 'unauthorized', 401);
    }) as GoogleAdapter['getJson'];

    await expect(
      serviceWith(getJson).discoverResources('org-1', 'authorization-1'),
    ).rejects.toMatchObject({
      code: 'INTEGRATION_ERROR',
      message: 'Google authorization is no longer valid; reconnect Google',
    });
  });

  it('keeps locations from accessible GBP accounts when another account fails', async () => {
    const getJson = vi.fn(async (url: string) => {
      if (url.includes('analyticsadmin')) return { accountSummaries: [] };
      if (url.includes('webmasters')) return { siteEntry: [] };
      if (url.endsWith('/v1/accounts')) {
        return {
          accounts: [
            { name: 'accounts/working', accountName: 'Working account' },
            { name: 'accounts/limited', accountName: 'Limited account' },
          ],
        };
      }
      if (url.includes('accounts/working/locations')) {
        return { locations: [{ name: 'locations/123', title: 'Capere CPA' }] };
      }
      throw new ProviderAdapterError('google', 'google returned HTTP 429', 'rate_limited', 429);
    }) as GoogleAdapter['getJson'];

    const result = await serviceWith(getJson).discoverResources('org-1', 'authorization-1');

    expect(result.gbp).toEqual([
      {
        id: 'locations/123',
        name: 'Capere CPA',
        account: 'Working account',
        parentAccount: 'accounts/working',
      },
    ]);
    expect(result.warnings).toContainEqual({
      provider: 'gbp',
      code: 'RATE_LIMITED',
      message: 'GBP resource discovery is temporarily unavailable',
      resourceId: 'accounts/limited',
    });
  });
});
