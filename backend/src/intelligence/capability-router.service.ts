import { Injectable } from '@nestjs/common';
import type { AgentKind } from '../shared/database';
import type { TaskType } from '../llm';
import { FeatureFlag, type FeatureFlagKey } from '../feature-flags';

export type IntelligenceCapability = 'general' | 'seo' | 'analytics' | 'cmo' | 'content';

export interface CapabilityPolicy {
  readonly capability: IntelligenceCapability;
  readonly agent: AgentKind;
  readonly taskType: TaskType;
  readonly systemPrompt:
    | 'intelligence.general.system'
    | 'intelligence.seo.system'
    | 'intelligence.analytics.system'
    | 'intelligence.cmo.system'
    | 'intelligence.content.system';
  readonly enabledFlag?: FeatureFlagKey;
  readonly allowMutatingTools: false;
}

@Injectable()
export class CapabilityRouter {
  resolve(capability: IntelligenceCapability): CapabilityPolicy {
    const policies: Record<IntelligenceCapability, CapabilityPolicy> = {
      general: {
        capability: 'general',
        agent: 'general',
        taskType: 'general',
        systemPrompt: 'intelligence.general.system',
        allowMutatingTools: false,
      },
      seo: {
        capability: 'seo',
        agent: 'seo',
        taskType: 'analytics',
        systemPrompt: 'intelligence.seo.system',
        enabledFlag: FeatureFlag.AgentSeo,
        allowMutatingTools: false,
      },
      analytics: {
        capability: 'analytics',
        agent: 'analytics',
        taskType: 'analytics',
        systemPrompt: 'intelligence.analytics.system',
        enabledFlag: FeatureFlag.AgentAnalytics,
        allowMutatingTools: false,
      },
      cmo: {
        capability: 'cmo',
        agent: 'cmo',
        taskType: 'general',
        systemPrompt: 'intelligence.cmo.system',
        enabledFlag: FeatureFlag.AgentCmo,
        allowMutatingTools: false,
      },
      content: {
        capability: 'content',
        agent: 'content',
        taskType: 'cheap',
        systemPrompt: 'intelligence.content.system',
        enabledFlag: FeatureFlag.AgentContent,
        allowMutatingTools: false,
      },
    };
    const policy = policies[capability];
    if (!policy) throw new Error(`Unknown intelligence capability: ${String(capability)}`);
    return policy;
  }
}
