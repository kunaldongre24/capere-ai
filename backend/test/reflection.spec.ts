import { describe, expect, it, vi } from 'vitest';
import { ReflectionService } from '../src/hermes/reflection/reflection.service';
import type { ModelRouterService } from '../src/llm';

function serviceWithCompletion(content?: string, error?: Error): ReflectionService {
  const complete = error
    ? vi.fn().mockRejectedValue(error)
    : vi.fn().mockResolvedValue({ content });
  return new ReflectionService({ complete } as unknown as ModelRouterService);
}

const baseRequest = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  agent: 'hermes' as const,
  userRequest: 'How are we performing?',
  draft: 'Revenue increased by 10%.',
  toolResults: [],
  reflectionPrompt: 'Review the response.',
};

describe('ReflectionService', () => {
  it('accepts a valid approval verdict', async () => {
    const reflection = serviceWithCompletion(
      JSON.stringify({ approved: true, issues: [], revisedResponse: null }),
    );
    await expect(reflection.review(baseRequest)).resolves.toEqual({
      approved: true,
      issues: [],
      revisedResponse: undefined,
    });
  });

  it('uses a valid revised response when the draft is rejected', async () => {
    const reflection = serviceWithCompletion(
      JSON.stringify({
        approved: false,
        issues: [{ kind: 'unsupported_metric', detail: 'No source.' }],
        revisedResponse: 'I do not have verified revenue data.',
      }),
    );
    await expect(reflection.review(baseRequest)).resolves.toMatchObject({
      approved: false,
      revisedResponse: 'I do not have verified revenue data.',
    });
  });

  it.each([
    ['provider failure', undefined, new Error('provider unavailable')],
    ['malformed JSON', '{not-json', undefined],
    [
      'schema-invalid rejection',
      JSON.stringify({ approved: false, issues: [], revisedResponse: null }),
      undefined,
    ],
  ])('fails closed on %s', async (_name, content, error) => {
    const verdict = await serviceWithCompletion(content, error).review(baseRequest);
    expect(verdict.approved).toBe(false);
    expect(verdict.revisedResponse).toMatch(/could not safely verify/i);
    expect(verdict.revisedResponse).not.toBe(baseRequest.draft);
  });
});
