import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../shared/config';
import { providerFetch, readJson } from '../provider-adapter';

export interface GoogleTokenSet {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type: string;
}

@Injectable()
export class GoogleAdapter {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  get redirectUri(): string {
    return this.config.google.redirectUri;
  }

  authorizationUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string {
    const query = new URLSearchParams({
      client_id: this.config.google.clientId,
      redirect_uri: input.redirectUri,
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
      scope: this.config.google.scopes.join(' '),
    });
    return `${this.config.google.authorizationUrl}?${query.toString()}`;
  }

  async exchangeCode(
    code: string,
    codeVerifier: string,
    redirectUri: string,
  ): Promise<GoogleTokenSet> {
    return this.tokenRequest({
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });
  }

  async refresh(refreshToken: string): Promise<GoogleTokenSet> {
    return this.tokenRequest({ refresh_token: refreshToken, grant_type: 'refresh_token' });
  }

  async getJson<T>(url: string, accessToken: string): Promise<T> {
    const response = await providerFetch('google', url, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    });
    return readJson<T>('google', response);
  }

  async postJson<T>(url: string, accessToken: string, body: unknown): Promise<T> {
    const response = await providerFetch('google', url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return readJson<T>('google', response);
  }

  private async tokenRequest(fields: Record<string, string>): Promise<GoogleTokenSet> {
    const response = await providerFetch('google', this.config.google.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...fields,
        client_id: this.config.google.clientId,
        client_secret: this.config.google.clientSecret,
      }),
    });
    return readJson<GoogleTokenSet>('google', response);
  }
}
