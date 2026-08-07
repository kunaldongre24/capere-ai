import { createSign } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../shared/config';
import { providerFetch, readJson } from '../provider-adapter';

@Injectable()
export class GithubAdapter {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async installationToken(installationId: string): Promise<{ token: string; expires_at: string }> {
    const jwt = this.appJwt();
    const response = await providerFetch(
      'github',
      `${this.config.github.apiUrl}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
      { method: 'POST', headers: this.headers(jwt) },
    );
    return readJson('github', response);
  }

  async getJson<T>(path: string, token: string): Promise<T> {
    const response = await providerFetch('github', `${this.config.github.apiUrl}${path}`, {
      headers: this.headers(token),
    });
    return readJson<T>('github', response);
  }

  async request<T>(path: string, method: string, token: string, body: unknown): Promise<T> {
    const response = await providerFetch('github', `${this.config.github.apiUrl}${path}`, {
      method,
      headers: this.headers(token),
      body: JSON.stringify(body),
    });
    return readJson<T>('github', response);
  }

  private headers(token: string): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'Capere-AI',
    };
  }

  private appJwt(): string {
    const now = Math.floor(Date.now() / 1_000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 540, iss: this.config.github.appId })}`;
    const signer = createSign('RSA-SHA256');
    signer.update(unsigned);
    return `${unsigned}.${signer.sign(this.config.github.privateKey, 'base64url')}`;
  }
}
