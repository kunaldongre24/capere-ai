import { describe, expect, it, vi } from 'vitest';
import {
  LlmProviderError,
  type LlmCompletion,
  type LlmProvider,
} from '../src/llm/llm-provider.port';
import { ModelRouterService } from '../src/llm/router/model-router.service';
import type { BudgetService } from '../src/llm/budgets/budget.service';
import type { UsageService } from '../src/llm/usage/usage.service';
import { loadConfig } from '../src/shared/config';

const chain = ['primary/model', 'fallback/model', 'last/model'];

function config() {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://postgres:password@localhost:5432/postgres',
    REDIS_URL: 'redis://localhost:6379',
    API_KEYS_HASHING_SALT: 'test-salt-0123456789abcdef',
    KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    OPENROUTER_MODELS_GENERAL: chain.join(','),
    OPENROUTER_MODELS_ANALYTICS: chain.join(','),
    OPENROUTER_MODELS_CHEAP: chain.join(','),
  });
}

function completion(model: string): LlmCompletion {
  return {
    servedModel: model,
    content: 'grounded answer',
    toolCalls: [],
    usage: {
      promptTokens: 20,
      completionTokens: 10,
      totalTokens: 30,
      costMicroUsd: 5,
    },
    finishReason: 'stop',
  };
}

function harness(provider: LlmProvider) {
  const usage = { record: vi.fn().mockResolvedValue('usage-id') };
  const budgets = {
    assertWithinBudget: vi.fn().mockResolvedValue(undefined),
    evaluateAfterUsage: vi.fn().mockResolvedValue(undefined),
  };
  return {
    router: new ModelRouterService(
      config(),
      provider,
      usage as unknown as UsageService,
      budgets as unknown as BudgetService,
    ),
    usage,
    budgets,
  };
}

describe('ModelRouterService fallback and ledger behavior', () => {
  it('records a retryable primary failure and the successful fallback position', async () => {
    const complete = vi
      .fn()
      .mockRejectedValueOnce(
        new LlmProviderError('OpenRouter returned no choices', 'server_error', true),
      )
      .mockResolvedValueOnce(completion(chain[1]));
    const provider = {
      name: 'openrouter',
      complete,
      stream: vi.fn(),
    } as unknown as LlmProvider;
    const { router, usage, budgets } = harness(provider);

    const result = await router.complete(
      { messages: [{ role: 'user', content: 'test' }] },
      { organizationId: crypto.randomUUID(), taskType: 'general' },
    );

    expect(result.servedModel).toBe(chain[1]);
    expect(complete.mock.calls.map(([request]) => request.model)).toEqual(chain.slice(0, 2));
    expect(usage.record).toHaveBeenCalledTimes(2);
    expect(usage.record.mock.calls[0][0]).toMatchObject({
      requestedModel: chain[0],
      fallbackIndex: 0,
      succeeded: false,
      errorCode: 'server_error',
    });
    expect(usage.record.mock.calls[1][0]).toMatchObject({
      requestedModel: chain[1],
      servedModel: chain[1],
      fallbackIndex: 1,
      succeeded: true,
    });
    expect(budgets.evaluateAfterUsage).toHaveBeenCalledOnce();
  });

  it('does not try another model for a non-retryable invalid request', async () => {
    const complete = vi
      .fn()
      .mockRejectedValue(new LlmProviderError('bad schema', 'invalid_request', false, 400));
    const provider = {
      name: 'openrouter',
      complete,
      stream: vi.fn(),
    } as unknown as LlmProvider;
    const { router, usage } = harness(provider);

    await expect(
      router.complete(
        { messages: [{ role: 'user', content: 'test' }] },
        { organizationId: crypto.randomUUID(), taskType: 'general' },
      ),
    ).rejects.toMatchObject({ status: 400 });

    expect(complete).toHaveBeenCalledOnce();
    expect(usage.record).toHaveBeenCalledOnce();
    expect(usage.record.mock.calls[0][0]).toMatchObject({
      requestedModel: chain[0],
      fallbackIndex: 0,
      succeeded: false,
      errorCode: 'invalid_request',
    });
  });

  it('falls back when streaming fails before the first emitted chunk', async () => {
    const attempted: string[] = [];
    const provider: LlmProvider = {
      name: 'openrouter',
      complete: vi.fn(),
      async *stream(request) {
        attempted.push(request.model);
        if (request.model === chain[0]) {
          throw new LlmProviderError('route unavailable', 'server_error', true);
        }
        yield { delta: 'answer' };
        yield {
          delta: '',
          servedModel: request.model,
          finishReason: 'stop',
          usage: {
            promptTokens: 10,
            completionTokens: 2,
            totalTokens: 12,
            costMicroUsd: 1,
          },
        };
      },
    };
    const { router, usage } = harness(provider);

    const chunks = [];
    for await (const chunk of router.stream(
      { messages: [{ role: 'user', content: 'test' }] },
      { organizationId: crypto.randomUUID(), taskType: 'general' },
    )) {
      chunks.push(chunk);
    }

    expect(attempted).toEqual(chain.slice(0, 2));
    expect(chunks.map((chunk) => chunk.delta).join('')).toBe('answer');
    expect(usage.record).toHaveBeenCalledTimes(2);
    expect(usage.record.mock.calls[1][0]).toMatchObject({
      requestedModel: chain[1],
      fallbackIndex: 1,
      succeeded: true,
    });
  });
});
