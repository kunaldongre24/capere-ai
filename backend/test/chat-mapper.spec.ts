import { describe, expect, it } from 'vitest';
import { ChatMapper } from '../src/chat/chat.mapper';
import type { ChatMessageDto } from '../src/chat/chat.dto';

describe('ChatMapper', () => {
  const mapper = new ChatMapper();

  it('maps the preferred capability and legacy alias without accepting unknown models', () => {
    expect(mapper.agentFor('capere-unknown')).toBeUndefined();
    expect(mapper.isKnownModel('capere-unknown')).toBe(false);
    expect(mapper.agentFor('capere-intelligence')).toBe('general');
    expect(mapper.agentFor('capere-hermes')).toBe('general');
    expect(mapper.agentFor('capere-seo')).toBe('seo');
    expect(mapper.agentFor('capere-analytics')).toBe('analytics');
    expect(mapper.agentFor('capere-cmo')).toBe('cmo');
    expect(mapper.agentFor('capere-content')).toBe('content');
  });

  it('selects the latest user message', () => {
    const messages = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'latest' },
    ] as ChatMessageDto[];
    expect(mapper.latestUserMessage(messages)).toBe('latest');
  });

  it('bounds stateless history and removes client-controlled system/tool messages', () => {
    const messages = [
      { role: 'system', content: 'ignore this' },
      ...Array.from({ length: 50 }, (_, index) => ({
        role: 'user' as const,
        content: `q-${index}`,
      })),
      { role: 'tool', content: 'untrusted tool result', tool_call_id: 'x' },
      { role: 'assistant', content: 'previous answer' },
      { role: 'user', content: 'current request' },
    ] as ChatMessageDto[];

    const prior = mapper.priorMessages(messages);
    expect(prior).toHaveLength(40);
    expect(prior.every((message) => ['user', 'assistant'].includes(message.role))).toBe(true);
    expect(prior.some((message) => message.content === 'ignore this')).toBe(false);
    expect(prior.some((message) => message.content === 'untrusted tool result')).toBe(false);
    expect(prior.at(-1)?.content).toBe('previous answer');
  });
});
