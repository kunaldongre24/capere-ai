export type ProviderErrorKind =
  'unauthorized' | 'forbidden' | 'rate_limited' | 'timeout' | 'unavailable' | 'invalid';

export class ProviderAdapterError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly kind: ProviderErrorKind,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ProviderAdapterError';
  }
}

export async function providerFetch(
  provider: string,
  input: string | URL,
  init: RequestInit = {},
  timeoutMs = 20_000,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(input, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timeout = error instanceof Error && error.name === 'TimeoutError';
    throw new ProviderAdapterError(
      provider,
      timeout ? `${provider} request timed out` : `${provider} request failed`,
      timeout ? 'timeout' : 'unavailable',
    );
  }
  if (response.ok) return response;
  const kind: ProviderErrorKind =
    response.status === 401
      ? 'unauthorized'
      : response.status === 403
        ? 'forbidden'
        : response.status === 408
          ? 'timeout'
          : response.status === 429
            ? 'rate_limited'
            : response.status >= 500
              ? 'unavailable'
              : 'invalid';
  const retryAfter = response.headers.get('retry-after');
  throw new ProviderAdapterError(
    provider,
    `${provider} returned HTTP ${response.status}`,
    kind,
    response.status,
    retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1_000 : undefined,
  );
}

export async function readJson<T>(provider: string, response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw new ProviderAdapterError(provider, `${provider} returned invalid JSON`, 'unavailable');
  }
}
