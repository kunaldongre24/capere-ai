import { afterEach, describe, expect, it, vi } from 'vitest';
import { GhlAdapter } from '../src/integrations/ghl/ghl.adapter';
import { loadConfig } from '../src/shared/config';

function adapter(): GhlAdapter {
  return new GhlAdapter(
    loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://postgres:password@localhost:5432/postgres',
      REDIS_URL: 'redis://localhost:6379',
      API_KEYS_HASHING_SALT: 'test-salt-0123456789abcdef',
      KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
      GHL_API_BASE_URL: 'https://ghl.test',
      GHL_CLIENT_ID: 'client-id',
      GHL_CLIENT_SECRET: 'client-secret',
      GHL_OAUTH_REDIRECT_URI: 'https://api.example.com/api/v1/integrations/crm/callback',
      GHL_AUTHORIZATION_URL: 'https://marketplace.example.com/oauth/chooselocation',
      GHL_TOKEN_URL: 'https://ghl.test/oauth/token',
    }),
  );
}

afterEach(() => vi.restoreAllMocks());

describe('GhlAdapter', () => {
  it('builds a state-bound OAuth authorization URL', () => {
    const configured = new GhlAdapter(
      loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://postgres:password@localhost:5432/postgres',
        REDIS_URL: 'redis://localhost:6379',
        API_KEYS_HASHING_SALT: 'test-salt-0123456789abcdef',
        KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
        GHL_CLIENT_ID: 'client-id',
        GHL_OAUTH_REDIRECT_URI: 'https://api.capereai.com/api/v1/integrations/crm/callback',
      }),
    );
    const url = new URL(configured.authorizationUrl('state-value'));
    expect(url.origin + url.pathname).toBe(
      'https://marketplace.gohighlevel.com/oauth/chooselocation',
    );
    expect(url.searchParams.get('client_id')).toBe('client-id');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://api.capereai.com/api/v1/integrations/crm/callback',
    );
    expect(url.searchParams.get('state')).toBe('state-value');
    expect(url.searchParams.get('scope')).toContain('contacts.readonly');
  });

  it('exchanges an OAuth code using the configured token endpoint', async () => {
    const configured = new GhlAdapter(
      loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://postgres:password@localhost:5432/postgres',
        REDIS_URL: 'redis://localhost:6379',
        API_KEYS_HASHING_SALT: 'test-salt-0123456789abcdef',
        KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
        GHL_CLIENT_ID: 'client-id',
        GHL_CLIENT_SECRET: 'client-secret',
        GHL_OAUTH_REDIRECT_URI: 'https://api.capereai.com/api/v1/integrations/crm/callback',
      }),
    );
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }), {
          status: 200,
        }),
      );
    await expect(configured.exchangeCode('auth-code')).resolves.toMatchObject({
      access_token: 'access',
      refresh_token: 'refresh',
    });
    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(request.body)).toContain('grant_type=authorization_code');
    expect(String(request.body)).toContain('client_id=client-id');
    expect(String(request.body)).toContain('client_secret=client-secret');
  });

  it('builds an OAuth authorization URL with state, redirect, and least-privilege scopes', () => {
    const url = new URL(adapter().authorizationUrl('state-value'));
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://marketplace.example.com/oauth/chooselocation',
    );
    expect(url.searchParams.get('client_id')).toBe('client-id');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://api.example.com/api/v1/integrations/crm/callback',
    );
    expect(url.searchParams.get('state')).toBe('state-value');
    expect(url.searchParams.get('scope')?.split(' ')).toEqual(
      expect.arrayContaining([
        'locations.readonly',
        'contacts.readonly',
        'contacts.write',
        'locations/tasks.write',
      ]),
    );
  });

  it('exchanges an authorization code using form encoding', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'access',
          refresh_token: 'refresh',
          expires_in: 86400,
          locationId: 'location-1',
        }),
        { status: 200 },
      ),
    );
    await expect(adapter().exchangeCode('code-value')).resolves.toMatchObject({
      access_token: 'access',
      locationId: 'location-1',
    });
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://ghl.test/oauth/token');
    const body = new URLSearchParams(String(request.body));
    expect(Object.fromEntries(body)).toMatchObject({
      grant_type: 'authorization_code',
      code: 'code-value',
      client_id: 'client-id',
      client_secret: 'client-secret',
      redirect_uri: 'https://api.example.com/api/v1/integrations/crm/callback',
    });
  });

  it('refreshes OAuth credentials with the installation user type', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'next', expires_in: 86400 }), { status: 200 }),
    );
    await adapter().refreshToken('refresh-value', 'Location');
    const body = new URLSearchParams(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(Object.fromEntries(body)).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-value',
      user_type: 'Location',
    });
  });
  it('builds authenticated JSON requests with encoded query parameters', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await expect(
      adapter().getJson({ accessToken: 'secret' }, '/opportunities/search', {
        location_id: 'location/a',
        page: 2,
        omitted: undefined,
      }),
    ).resolves.toEqual({ ok: true });

    const [url, request] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      'https://ghl.test/opportunities/search?location_id=location%2Fa&page=2',
    );
    expect(request.headers).toMatchObject({
      authorization: 'Bearer secret',
      accept: 'application/json',
      version: '2021-07-28',
    });
  });

  it.each([
    [401, 'unauthorized'],
    [408, 'timeout'],
    [429, 'rate_limited'],
    [503, 'unavailable'],
  ] as const)('classifies getJson HTTP %s as %s', async (status, kind) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status }));

    await expect(adapter().getJson({ accessToken: 'token' }, 'anything')).rejects.toMatchObject({
      kind,
      status,
    });
  });

  it('rejects invalid JSON from getJson', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not-json', { status: 200 }));
    await expect(adapter().getJson({ accessToken: 'token' }, 'anything')).rejects.toMatchObject({
      kind: 'unavailable',
    });
  });

  it('rejects a returned location that differs from the requested location', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ location: { id: 'location-b' } }), { status: 200 }),
    );

    await expect(
      adapter().getLocation({ accessToken: 'token' }, 'location-a'),
    ).rejects.toMatchObject({ kind: 'invalid' });
  });

  it.each([
    [401, 'unauthorized'],
    [408, 'timeout'],
    [429, 'rate_limited'],
    [503, 'unavailable'],
  ] as const)('classifies HTTP %s as %s', async (status, kind) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status }));

    await expect(
      adapter().getLocation({ accessToken: 'token' }, 'location-a'),
    ).rejects.toMatchObject({ kind, status });
  });

  it('rejects malformed successful responses as provider failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not-json', { status: 200 }));

    await expect(
      adapter().getLocation({ accessToken: 'token' }, 'location-a'),
    ).rejects.toMatchObject({ kind: 'unavailable' });
  });
});
