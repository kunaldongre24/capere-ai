export interface EmbeddingUsage {
  readonly promptTokens: number;
  readonly totalTokens: number;
  readonly costMicroUsd: number | null;
}

export interface EmbeddingResult {
  readonly model: string;
  readonly dimensions: number;
  readonly vectors: readonly number[][];
  readonly usage: EmbeddingUsage;
}

export interface EmbeddingProvider {
  readonly name: string;
  embed(inputs: readonly string[], signal?: AbortSignal): Promise<EmbeddingResult>;
}

export const EMBEDDING_PROVIDER = Symbol('EMBEDDING_PROVIDER');

export class EmbeddingProviderError extends Error {
  constructor(
    message: string,
    readonly code: 'rate_limited' | 'timeout' | 'invalid_request' | 'auth_failed' | 'server_error',
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'EmbeddingProviderError';
  }
}
