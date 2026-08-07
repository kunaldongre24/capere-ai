import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { CapabilityRouter } from '../src/intelligence/capability-router.service';
import { ToolRegistry } from '../src/intelligence/tools/tool-registry';

describe('Phase 4 capability policies', () => {
  it('maps every specialist to a distinct agent, prompt, and task class', () => {
    const router = new CapabilityRouter();
    expect(router.resolve('seo')).toMatchObject({
      agent: 'seo',
      taskType: 'analytics',
      systemPrompt: 'intelligence.seo.system',
    });
    expect(router.resolve('analytics')).toMatchObject({
      agent: 'analytics',
      taskType: 'analytics',
      systemPrompt: 'intelligence.analytics.system',
    });
    expect(router.resolve('cmo')).toMatchObject({
      agent: 'cmo',
      taskType: 'general',
      systemPrompt: 'intelligence.cmo.system',
    });
    expect(router.resolve('content')).toMatchObject({
      agent: 'content',
      taskType: 'cheap',
      systemPrompt: 'intelligence.content.system',
    });
  });

  it('rejects unknown runtime capabilities instead of returning undefined', () => {
    const router = new CapabilityRouter();
    expect(() => router.resolve('invented' as never)).toThrow('Unknown intelligence capability');
  });

  it('enforces agent tool scope for descriptors and direct fabricated calls', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'cmo_only_tool',
      description: 'CMO evidence.',
      schema: z.object({}),
      permissions: ['owner'],
      agents: ['cmo'],
      timeoutMs: 1000,
      execute: async () => ({ ok: true }),
    });
    expect(registry.descriptorsFor('owner', { agent: 'content' })).toEqual([]);
    expect(registry.descriptorsFor('owner', { agent: 'cmo' })).toHaveLength(1);
    const result = await registry.execute('cmo_only_tool', '{}', {
      organizationId: '00000000-0000-0000-0000-000000000001',
      role: 'owner',
      agent: 'content',
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'permission_denied' } });
  });
});
