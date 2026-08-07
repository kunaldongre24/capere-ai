import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../shared/config';

export interface GhlCredentials {
  readonly accessToken: string;
  readonly refreshToken?: string | null;
  readonly userType?: string;
}

export interface GhlTokenSet {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly expires_in: number;
  readonly token_type?: string;
  readonly scope?: string;
  readonly locationId?: string;
  readonly companyId?: string;
  readonly userId?: string;
  readonly userType?: string;
}

export interface GhlLocation {
  readonly id: string;
  readonly name?: string;
  readonly timezone?: string;
}

export type GhlErrorKind = 'unauthorized' | 'rate_limited' | 'timeout' | 'unavailable' | 'invalid';

export class GhlAdapterError extends Error {
  constructor(
    message: string,
    readonly kind: GhlErrorKind,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GhlAdapterError';
  }
}

@Injectable()
export class GhlAdapter {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  get redirectUri(): string {
    return this.config.ghl.redirectUri;
  }

  get scopes(): readonly string[] {
    return this.config.ghl.scopes;
  }

  authorizationUrl(state: string): string {
    if (!this.config.ghl.clientId || !this.config.ghl.redirectUri)
      throw new GhlAdapterError('GoHighLevel OAuth is not configured', 'invalid');
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.ghl.clientId,
      redirect_uri: this.config.ghl.redirectUri,
      scope: this.config.ghl.scopes.join(' '),
      state,
    });
    return `${this.config.ghl.authorizationUrl}?${query.toString()}`;
  }

  exchangeCode(code: string): Promise<GhlTokenSet> {
    return this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.ghl.redirectUri,
    });
  }

  refreshToken(refreshToken: string, userType?: string): Promise<GhlTokenSet> {
    return this.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      ...(userType ? { user_type: userType } : {}),
    });
  }

  async getLocation(credentials: GhlCredentials, locationId: string): Promise<GhlLocation> {
    let response: Response;
    try {
      response = await fetch(
        `${this.config.ghl.baseUrl.replace(/\/$/, '')}/locations/${encodeURIComponent(locationId)}`,
        {
          headers: {
            authorization: `Bearer ${credentials.accessToken}`,
            accept: 'application/json',
            version: '2021-07-28',
          },
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch (error) {
      if (error instanceof GhlAdapterError) throw error;
      throw new GhlAdapterError(
        error instanceof Error && error.name === 'TimeoutError'
          ? 'GoHighLevel request timed out'
          : 'GoHighLevel request failed',
        error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'unavailable',
      );
    }
    if (!response.ok) {
      const kind: GhlErrorKind =
        response.status === 401 || response.status === 403
          ? 'unauthorized'
          : response.status === 408
            ? 'timeout'
            : response.status === 429
              ? 'rate_limited'
              : response.status >= 500
                ? 'unavailable'
                : 'invalid';
      throw new GhlAdapterError(
        `GoHighLevel location verification failed with HTTP ${response.status}`,
        kind,
        response.status,
      );
    }
    let body: { location?: { id?: string; name?: string; timezone?: string } };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      throw new GhlAdapterError('GoHighLevel returned an invalid JSON response', 'unavailable');
    }
    const location = body.location;
    if (!location?.id) {
      throw new GhlAdapterError('GoHighLevel returned no location identifier', 'unavailable');
    }
    if (location.id !== locationId) {
      throw new GhlAdapterError(
        'GoHighLevel returned a different location than requested',
        'invalid',
      );
    }
    return { id: location.id, name: location.name, timezone: location.timezone };
  }

  async getJson<T>(
    credentials: GhlCredentials,
    path: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<T> {
    const url = new URL(`${this.config.ghl.baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`);
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) url.searchParams.set(key, String(value));
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          authorization: `Bearer ${credentials.accessToken}`,
          accept: 'application/json',
          version: '2021-07-28',
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new GhlAdapterError(
        error instanceof Error && error.name === 'TimeoutError'
          ? 'GoHighLevel request timed out'
          : 'GoHighLevel request failed',
        error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'unavailable',
      );
    }
    if (!response.ok) {
      const kind: GhlErrorKind =
        response.status === 401 || response.status === 403
          ? 'unauthorized'
          : response.status === 408
            ? 'timeout'
            : response.status === 429
              ? 'rate_limited'
              : response.status >= 500
                ? 'unavailable'
                : 'invalid';
      throw new GhlAdapterError(
        `GoHighLevel request failed with HTTP ${response.status}`,
        kind,
        response.status,
      );
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new GhlAdapterError('GoHighLevel returned invalid JSON', 'unavailable');
    }
  }

  async postJson<T>(credentials: GhlCredentials, path: string, body: unknown): Promise<T> {
    const url = `${this.config.ghl.baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${credentials.accessToken}`,
          accept: 'application/json',
          'content-type': 'application/json',
          version: '2021-07-28',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new GhlAdapterError(
        error instanceof Error && error.name === 'TimeoutError'
          ? 'GoHighLevel request timed out'
          : 'GoHighLevel request failed',
        error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'unavailable',
      );
    }
    if (!response.ok) {
      const kind: GhlErrorKind =
        response.status === 401 || response.status === 403
          ? 'unauthorized'
          : response.status === 408
            ? 'timeout'
            : response.status === 429
              ? 'rate_limited'
              : response.status >= 500
                ? 'unavailable'
                : 'invalid';
      throw new GhlAdapterError(
        `GoHighLevel request failed with HTTP ${response.status}`,
        kind,
        response.status,
      );
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new GhlAdapterError('GoHighLevel returned invalid JSON', 'unavailable');
    }
  }

  private async tokenRequest(fields: Record<string, string>): Promise<GhlTokenSet> {
    if (!this.config.ghl.clientId || !this.config.ghl.clientSecret)
      throw new GhlAdapterError('GoHighLevel OAuth is not configured', 'invalid');
    let response: Response;
    try {
      response = await fetch(this.config.ghl.tokenUrl, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          ...fields,
          client_id: this.config.ghl.clientId,
          client_secret: this.config.ghl.clientSecret,
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new GhlAdapterError(
        error instanceof Error && error.name === 'TimeoutError'
          ? 'GoHighLevel token request timed out'
          : 'GoHighLevel token request failed',
        error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'unavailable',
      );
    }
    if (!response.ok) {
      const kind: GhlErrorKind =
        response.status === 429
          ? 'rate_limited'
          : response.status >= 500
            ? 'unavailable'
            : 'unauthorized';
      throw new GhlAdapterError(
        `GoHighLevel token request failed with HTTP ${response.status}`,
        kind,
        response.status,
      );
    }
    try {
      const token = (await response.json()) as GhlTokenSet;
      if (!token.access_token || !token.expires_in)
        throw new GhlAdapterError('GoHighLevel returned an incomplete token response', 'unavailable');
      return token;
    } catch (error) {
      if (error instanceof GhlAdapterError) throw error;
      throw new GhlAdapterError('GoHighLevel returned an invalid token response', 'unavailable');
    }
  }
}
