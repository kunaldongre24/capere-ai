import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AgentKind } from '../shared/database';
import type { IntelligenceCapability } from '../intelligence';
import type { ChatMessageDto } from './chat.dto';

/**
 * The models Capere advertises to Open WebUI.
 *
 * These are NOT raw provider models. Exposing `anthropic/claude-3.5-sonnet`
 * directly would let a user bypass Capere intelligence — no organization context,
 * no tools, no budget accounting, no reflection. Instead each entry names a
 * CAPABILITY, and Capere decides which underlying model serves it.
 *
 * That indirection is what makes the model routing, cost controls and prompt
 * versioning meaningful: every conversation goes through the orchestrator.
 */
export interface CapereModel {
  readonly id: string;
  readonly capability: IntelligenceCapability;
  readonly description: string;
}

export const CAPERE_MODELS: readonly CapereModel[] = [
  {
    id: 'capere-intelligence',
    capability: 'general',
    description: 'Stateless general intelligence over your firm data, SEO and analytics.',
  },
  {
    id: 'capere-hermes',
    capability: 'general',
    description: 'Deprecated compatibility alias for capere-intelligence.',
  },
  {
    id: 'capere-seo',
    capability: 'seo',
    description: 'Technical SEO, rankings, competitors, GBP and search visibility.',
  },
  {
    id: 'capere-analytics',
    capability: 'analytics',
    description: 'Grounded KPI, conversion and trend analysis.',
  },
  {
    id: 'capere-cmo',
    capability: 'cmo',
    description: 'Revenue opportunities, retention and marketing strategy.',
  },
  {
    id: 'capere-content',
    capability: 'content',
    description: 'Grounded CPA blogs, GBP posts, email and metadata.',
  },
];

@Injectable()
export class ChatMapper {
  /** Resolves an advertised model id to an agent. */
  agentFor(modelId: string): AgentKind | undefined {
    const capability = this.capabilityFor(modelId);
    if (!capability) return undefined;
    const agents: Record<IntelligenceCapability, AgentKind> = {
      general: 'general',
      seo: 'seo',
      analytics: 'analytics',
      cmo: 'cmo',
      content: 'content',
    };
    return agents[capability];
  }

  capabilityFor(modelId: string): IntelligenceCapability | undefined {
    return CAPERE_MODELS.find((model) => model.id === modelId)?.capability;
  }

  isKnownModel(modelId: string): boolean {
    return CAPERE_MODELS.some((m) => m.id === modelId);
  }

  /**
   * Extracts the user's actual question from an OpenAI-style message array.
   *
   * Open WebUI sends the full history on every request. A session request reloads history
   * from its own conversation memory when a session is supplied, so only the
   * latest user turn is needed — passing the client's copy as well would
   * duplicate every prior turn in the prompt.
   */
  latestUserMessage(messages: ChatMessageDto[]): string {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    return lastUser?.content ?? '';
  }

  /**
   * Prior turns, for a STATELESS request (no session_id).
   *
   * Without a session there is no server-side memory, so the client's history
   * is the only context available.
   */
  priorMessages(messages: ChatMessageDto[]): ChatMessageDto[] {
    const lastUserIndex = messages.map((m) => m.role).lastIndexOf('user');
    if (lastUserIndex <= 0) return [];

    return messages
      .slice(0, lastUserIndex)
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .slice(-40);
  }

  completionId(): string {
    return `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  }

  /** Unix seconds, as the OpenAI schema requires. */
  createdAt(): number {
    return Math.floor(Date.now() / 1000);
  }
}
