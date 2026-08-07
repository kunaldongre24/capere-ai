import { describe, expect, it, vi } from 'vitest';
import { FeatureFlag } from '../src/feature-flags';
import { CapabilityRouter } from '../src/intelligence/capability-router.service';
import { GenerateChatResponseUseCase } from '../src/intelligence/generate-chat-response.use-case';
import type { ContextBuilder } from '../src/intelligence/context/context-builder';
import type { ToolExecutionService } from '../src/intelligence/execution/tool-execution.service';
import type { MemoryService } from '../src/intelligence/memory/memory.service';
import type { PromptRegistryService } from '../src/intelligence/prompts/prompt-registry.service';
import type { ResponseReviewService } from '../src/intelligence/review/response-review.service';
import type { FeatureFlagService } from '../src/feature-flags';

describe('GenerateChatResponseUseCase', () => {
  it('keeps ephemeral requests process and persistence stateless', async () => {
    const fixture = makeFixture();
    const result = await fixture.useCase.execute({
      organizationId: '00000000-0000-0000-0000-000000000001',
      role: 'owner',
      capability: 'general',
      message: 'What changed this week?',
      priorMessages: [{ role: 'user', content: 'Earlier question' }],
      ephemeral: true,
    });

    expect(result.content).toBe('Grounded answer');
    expect(result.sessionId).toBeUndefined();
    expect(fixture.memory.createSession).not.toHaveBeenCalled();
    expect(fixture.memory.append).not.toHaveBeenCalled();
    expect(fixture.execution.run).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'general', allowMutatingTools: false, toolsEnabled: true }),
    );
  });

  it('persists optional durable sessions and reviewed responses', async () => {
    const fixture = makeFixture({ reviewEnabled: true });
    const result = await fixture.useCase.execute({
      organizationId: '00000000-0000-0000-0000-000000000001',
      userId: '00000000-0000-0000-0000-000000000002',
      role: 'owner',
      capability: 'general',
      message: 'Create a morning brief',
      ephemeral: false,
    });

    expect(result.sessionId).toBe('session-1');
    expect(result.reviewed).toBe(true);
    expect(fixture.memory.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'general' }),
    );
    expect(fixture.memory.append).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['seo', 'seo', 'analytics', 'intelligence.seo.system'],
    ['analytics', 'analytics', 'analytics', 'intelligence.analytics.system'],
    ['cmo', 'cmo', 'general', 'intelligence.cmo.system'],
    ['content', 'content', 'cheap', 'intelligence.content.system'],
  ] as const)(
    'routes the %s capability through its specialist policy',
    async (capability, agent, taskType, promptName) => {
      const fixture = makeFixture();
      await fixture.useCase.execute({
        organizationId: '00000000-0000-0000-0000-000000000001',
        role: 'owner',
        capability,
        message: 'Specialist request',
        ephemeral: true,
      });
      expect(fixture.prompts.resolve).toHaveBeenCalledWith(
        promptName,
        expect.any(String),
        expect.any(Object),
      );
      expect(fixture.execution.run).toHaveBeenCalledWith(
        expect.objectContaining({ agent, taskType, allowMutatingTools: false }),
      );
    },
  );
});

function makeFixture(options: { reviewEnabled?: boolean } = {}) {
  const memory = {
    createSession: vi.fn().mockResolvedValue('session-1'),
    assertSessionAccess: vi.fn().mockResolvedValue(undefined),
    snapshot: vi.fn().mockResolvedValue({
      conversation: [],
      business: [],
      semantic: [],
      semanticAvailable: false,
      working: {},
    }),
    append: vi.fn().mockResolvedValue({}),
  };
  const context = {
    forOrganization: vi.fn().mockResolvedValue({
      organizationId: 'org',
      organizationName: 'Acme CPA',
      ghlLocations: [],
      integrations: [],
      activeInsights: [],
    }),
    render: vi.fn().mockReturnValue('CURRENT ORGANIZATION CONTEXT'),
  };
  const prompts = {
    resolve: vi.fn().mockImplementation((name: string) =>
      Promise.resolve({
        name,
        content: 'SYSTEM',
        version: 1,
        checksum: 'checksum',
        overridden: false,
      }),
    ),
  };
  const execution = {
    run: vi.fn().mockResolvedValue({
      content: 'Grounded answer',
      messages: [
        { role: 'system', content: 'SYSTEM' },
        { role: 'user', content: 'Question' },
        { role: 'assistant', content: 'Grounded answer' },
      ],
      toolResults: [],
      iterations: 1,
      exhausted: false,
    }),
  };
  const reviewer = { review: vi.fn().mockResolvedValue({ approved: true, issues: [] }) };
  const flags = {
    isEnabled: vi
      .fn()
      .mockImplementation((_org: string, key: string) =>
        Promise.resolve(
          key === FeatureFlag.IntelligenceBoundedTools ||
            [
              FeatureFlag.AgentSeo,
              FeatureFlag.AgentAnalytics,
              FeatureFlag.AgentCmo,
              FeatureFlag.AgentContent,
            ].some((flag) => flag === key) ||
            (key === FeatureFlag.IntelligenceResponseReview && options.reviewEnabled === true),
        ),
      ),
  };
  const useCase = new GenerateChatResponseUseCase(
    new CapabilityRouter(),
    context as unknown as ContextBuilder,
    memory as unknown as MemoryService,
    prompts as unknown as PromptRegistryService,
    execution as unknown as ToolExecutionService,
    reviewer as unknown as ResponseReviewService,
    flags as unknown as FeatureFlagService,
  );
  return { useCase, memory, execution, prompts };
}
