import { describe, expect, it } from 'vitest';
import { sanitizeHttpRequest } from '../src/shared/logging/logger.factory';

describe('HTTP request log sanitization', () => {
  it('redacts OAuth secrets from URLs and parsed query objects', () => {
    expect(
      sanitizeHttpRequest({
        method: 'GET',
        url: '/api/v1/integrations/google/callback?state=secret-state&code=secret-code&scope=email',
        originalUrl:
          '/api/v1/integrations/google/callback?state=secret-state&code=secret-code&scope=email',
        query: { state: 'secret-state', code: 'secret-code', scope: 'email' },
      }),
    ).toEqual({
      method: 'GET',
      url: '/api/v1/integrations/google/callback?state=%5BREDACTED%5D&code=%5BREDACTED%5D&scope=email',
      originalUrl:
        '/api/v1/integrations/google/callback?state=%5BREDACTED%5D&code=%5BREDACTED%5D&scope=email',
      query: { state: '[REDACTED]', code: '[REDACTED]', scope: 'email' },
    });
  });
});
