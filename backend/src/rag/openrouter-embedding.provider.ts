import type { AppConfig } from '../shared/config';
import {
  EmbeddingProviderError,
  type EmbeddingProvider,
  type EmbeddingResult,
} from './embedding.port';

interface OpenRouterEmbeddingResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
  model?: string;
  usage?: { prompt_tokens?: number; total_tokens?: number; cost?: number };
  error?: { message?: string };
}

export class OpenRouterEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openrouter';

  constructor(private readonly config: AppConfig) {}

  async embed(inputs: readonly string[], signal?: AbortSignal): Promise<EmbeddingResult> {
    if (inputs.length === 0) {
      return {
        model: this.config.rag.embeddingModel,
        dimensions: this.config.rag.embeddingDimensions,
        vectors: [],
        usage: { promptTokens: 0, totalTokens: 0, costMicroUsd: 0 },
      };
    }
    const timeout = AbortSignal.timeout(this.config.openRouter.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(`${this.config.openRouter.baseUrl.replace(/\/$/, '')}/embeddings`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.openRouter.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.rag.embeddingModel,
          input: inputs,
          dimensions: this.config.rag.embeddingDimensions,
        }),
        signal: combined,
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw new EmbeddingProviderError(
        timedOut ? 'OpenRouter embedding request timed out' : 'OpenRouter embedding request failed',
        timedOut ? 'timeout' : 'server_error',
        true,
      );
    }

    const body = (await response.json().catch(() => ({}))) as OpenRouterEmbeddingResponse;
    if (!response.ok) {
      const code =
        response.status === 401 || response.status === 403
          ? 'auth_failed'
          : response.status === 429
            ? 'rate_limited'
            : response.status >= 500
              ? 'server_error'
              : 'invalid_request';
      throw new EmbeddingProviderError(
        body.error?.message ?? `OpenRouter embedding request failed with ${response.status}`,
        code,
        code === 'rate_limited' || code === 'server_error',
        response.status,
      );
    }

    const vectors = [...(body.data ?? [])]
      .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
      .map((item) => item.embedding ?? []);
    if (
      vectors.length !== inputs.length ||
      vectors.some((vector) => vector.length !== this.config.rag.embeddingDimensions)
    ) {
      throw new EmbeddingProviderError(
        'OpenRouter returned an invalid embedding shape',
        'server_error',
        true,
      );
    }

    const cost = body.usage?.cost;
    return {
      model: body.model ?? this.config.rag.embeddingModel,
      dimensions: this.config.rag.embeddingDimensions,
      vectors,
      usage: {
        promptTokens: body.usage?.prompt_tokens ?? 0,
        totalTokens: body.usage?.total_tokens ?? body.usage?.prompt_tokens ?? 0,
        costMicroUsd: typeof cost === 'number' ? Math.round(cost * 1_000_000) : null,
      },
    };
  }
}
