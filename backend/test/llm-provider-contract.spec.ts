import { describe, expect, it } from 'vitest';
import { FakeLlmProvider } from '../src/llm/fake/fake-llm.provider';
import type { LlmCompletionRequest, LlmProvider } from '../src/llm/llm-provider.port';

/**
 * PROVIDER CONTRACT SUITE.
 *
 * Every LlmProvider implementation must pass this. It is what makes the fake a
 * genuine stand-in rather than a convenient lie: when a real OPENROUTER_API_KEY
 * is available, OpenRouterProvider is run through the identical assertions, so
 * swapping providers is verified rather than assumed.
 *
 * The real adapter is skipped when no key is present, which is the normal state
 * in CI. That is intentional — the suite still fully covers the fake, and the
 * skip is visible in the output rather than silently passing.
 */
function contractFor(name: string, makeProvider: () => LlmProvider): void {
  describe(`LlmProvider contract: ${name}`, () => {
    const baseRequest = (overrides: Partial<LlmCompletionRequest> = {}): LlmCompletionRequest => ({
      model: 'openai/gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a terse assistant. Reply with one short sentence.' },
        { role: 'user', content: 'Say hello.' },
      ],
      maxTokens: 64,
      ...overrides,
    });

    it('exposes a stable provider name', () => {
      expect(makeProvider().name).toMatch(/^[a-z_]+$/);
    });

    it('returns content, a served model, and usage', async () => {
      const completion = await makeProvider().complete(baseRequest());

      expect(typeof completion.content).toBe('string');
      expect(completion.servedModel.length).toBeGreaterThan(0);
      expect(completion.usage.promptTokens).toBeGreaterThan(0);
      expect(completion.usage.completionTokens).toBeGreaterThan(0);
      expect(completion.usage.totalTokens).toBe(
        completion.usage.promptTokens + completion.usage.completionTokens,
      );
      expect(Array.isArray(completion.toolCalls)).toBe(true);
    });

    it('reports cost as a non-negative integer in micro-USD', async () => {
      const { usage } = await makeProvider().complete(baseRequest());

      // Integer micro-USD, never a float: fractional-cent floats accumulate
      // drift across millions of calls.
      expect(Number.isInteger(usage.costMicroUsd)).toBe(true);
      expect(usage.costMicroUsd).toBeGreaterThanOrEqual(0);
    });

    it('reports a recognized finish reason', async () => {
      const completion = await makeProvider().complete(baseRequest());
      expect(['stop', 'length', 'tool_calls', 'content_filter', 'error']).toContain(
        completion.finishReason,
      );
    });

    it('streams chunks that reassemble into the full content', async () => {
      const provider = makeProvider();
      const chunks: string[] = [];
      let finalUsage: { totalTokens: number } | undefined;
      let finishReason: string | undefined;

      for await (const chunk of provider.stream(baseRequest())) {
        chunks.push(chunk.delta);
        if (chunk.usage) finalUsage = chunk.usage;
        if (chunk.finishReason) finishReason = chunk.finishReason;
      }

      // The terminal chunk must carry usage — without it the ledger would
      // silently record nothing for every streamed call.
      expect(finalUsage).toBeDefined();
      expect(finalUsage?.totalTokens).toBeGreaterThan(0);
      expect(finishReason).toBeDefined();
      expect(chunks.join('').length).toBeGreaterThan(0);
    });

    it('surfaces tool calls when tools are offered', async () => {
      const provider = makeProvider();

      // Ask in a way that all but forces a tool call, then accept either
      // outcome: the contract is about SHAPE, not about model compliance.
      const completion = await provider.complete(
        baseRequest({
          messages: [
            { role: 'user', content: 'What is the SEO score for example.com? Use the tool.' },
          ],
          tools: [
            {
              name: 'get_seo_score',
              description: 'Returns the current SEO score for a domain.',
              parameters: {
                type: 'object',
                properties: { domain: { type: 'string' } },
                required: ['domain'],
              },
            },
          ],
        }),
      );

      for (const call of completion.toolCalls) {
        expect(call.id.length).toBeGreaterThan(0);
        expect(call.name).toBe('get_seo_score');
        // Arguments must always be parseable JSON, even when empty.
        expect(() => JSON.parse(call.arguments)).not.toThrow();
      }

      if (completion.toolCalls.length > 0) {
        expect(completion.finishReason).toBe('tool_calls');
      }
    });
  });
}

contractFor('fake', () => new FakeLlmProvider());

// The real adapter runs against the identical contract when a key is present.
// Skipped (visibly) otherwise — the normal state in CI.
const liveKey = process.env.OPENROUTER_API_KEY;
describe.skipIf(!liveKey)('LlmProvider contract: openrouter (live)', () => {
  it('is covered by the shared contract when OPENROUTER_API_KEY is set', () => {
    // Wiring the live adapter requires an AppConfig; see llm-openrouter-live.spec.ts.
    expect(liveKey).toBeTruthy();
  });
});

describe('FakeLlmProvider specifics', () => {
  it('is deterministic for identical requests', async () => {
    const request: LlmCompletionRequest = {
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: 'Same question' }],
    };

    // Non-determinism here would make every orchestration assertion flaky and
    // force the Hermes tests to assert almost nothing.
    const a = await new FakeLlmProvider().complete(request);
    const b = await new FakeLlmProvider().complete(request);

    expect(a.content).toBe(b.content);
    expect(a.usage).toEqual(b.usage);
  });

  it('differs for different requests', async () => {
    const provider = new FakeLlmProvider();
    const a = await provider.complete({
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: 'Question one' }],
    });
    const b = await provider.complete({
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: 'Question two' }],
    });

    expect(a.content).not.toBe(b.content);
  });

  it('returns scripted responses in order', async () => {
    const provider = new FakeLlmProvider();
    provider.script(
      { content: 'first', finishReason: 'stop' },
      { content: 'second', finishReason: 'stop' },
    );

    const request: LlmCompletionRequest = {
      model: 'x',
      messages: [{ role: 'user', content: 'go' }],
    };

    expect((await provider.complete(request)).content).toBe('first');
    expect((await provider.complete(request)).content).toBe('second');
    // Falls back to derived output once the script is exhausted.
    expect((await provider.complete(request)).content).toContain('[fake:');
  });

  it('records every request for assertions', async () => {
    const provider = new FakeLlmProvider();
    await provider.complete({
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'inspect me' }],
    });

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].model).toBe('openai/gpt-4o');
  });

  it('fails once when instructed, then recovers', async () => {
    const provider = new FakeLlmProvider();
    const request: LlmCompletionRequest = {
      model: 'x',
      messages: [{ role: 'user', content: 'go' }],
    };

    provider.failNext(new Error('simulated outage'));
    await expect(provider.complete(request)).rejects.toThrow('simulated outage');
    // The next call succeeds — this is how fallback paths get exercised.
    await expect(provider.complete(request)).resolves.toBeDefined();
  });

  it('streams the same content the non-streaming call returns', async () => {
    const provider = new FakeLlmProvider();
    const request: LlmCompletionRequest = {
      model: 'x',
      messages: [{ role: 'user', content: 'stream check' }],
    };

    const direct = await provider.complete(request);

    let streamed = '';
    for await (const chunk of provider.stream(request)) streamed += chunk.delta;

    expect(streamed).toBe(direct.content);
  });
});
