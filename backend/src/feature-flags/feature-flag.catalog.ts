/**
 * Feature flag catalog.
 *
 * Flags are declared here as code, not invented at call sites, so the full set
 * of toggles is greppable and every flag has a documented owner and intent. A
 * flag whose key is a bare string scattered through the codebase becomes
 * undeletable — nobody can prove it is unused.
 *
 * Lifecycle: a flag is temporary scaffolding. `introducedIn` and `retireAfter`
 * exist so stale flags are visible rather than accumulating silently. When a
 * feature is fully rolled out, delete the flag and its branches.
 */

export const FeatureFlag = {
  /** Stateless response-review pass. */
  IntelligenceResponseReview: 'intelligence.response_review',
  /** Capped read-only model-selected tool execution. */
  IntelligenceBoundedTools: 'intelligence.bounded_tools',
  AgentSeo: 'agent.seo',
  AgentAnalytics: 'agent.analytics',
  AgentCmo: 'agent.cmo',
  AgentContent: 'agent.content',
  /** Hermes reflection pass — critique output before returning it. */
  HermesReflection: 'hermes.reflection',
  /** Legacy unused planner flag retained only for compatibility through Phase 4. */
  HermesPlanner: 'hermes.planner',
  /** Semantic (RAG) memory layer. Requires the configured vector store. */
  SemanticMemory: 'memory.semantic',
  /** Insights engine generates insights from domain events. */
  InsightsEngine: 'insights.engine',
  /** Enforce AI budget hard limits (vs warn-only). */
  AiBudgetEnforcement: 'ai.budget_enforcement',
  /** Streaming responses on the OpenAI-compatible chat endpoint. */
  ChatStreaming: 'chat.streaming',
} as const;

export type FeatureFlagKey = (typeof FeatureFlag)[keyof typeof FeatureFlag];

export interface FeatureFlagDefinition {
  readonly key: FeatureFlagKey;
  readonly description: string;
  /** Value used when an organization has no explicit override. */
  readonly defaultEnabled: boolean;
  readonly introducedIn: string;
  /** ISO date after which this flag should be removed, if temporary. */
  readonly retireAfter?: string;
}

export const FEATURE_FLAG_DEFINITIONS: readonly FeatureFlagDefinition[] = [
  {
    key: FeatureFlag.IntelligenceResponseReview,
    description: 'Review generated responses before returning them.',
    defaultEnabled: true,
    introducedIn: 'phase-3',
  },
  {
    key: FeatureFlag.IntelligenceBoundedTools,
    description: 'Allow capped read-only model-selected tool execution.',
    defaultEnabled: true,
    introducedIn: 'phase-3',
  },
  {
    key: FeatureFlag.AgentSeo,
    description: 'SEO specialist capability.',
    defaultEnabled: true,
    introducedIn: 'phase-4',
  },
  {
    key: FeatureFlag.AgentAnalytics,
    description: 'Analytics specialist capability.',
    defaultEnabled: true,
    introducedIn: 'phase-4',
  },
  {
    key: FeatureFlag.AgentCmo,
    description: 'AI CMO capability.',
    defaultEnabled: true,
    introducedIn: 'phase-4',
  },
  {
    key: FeatureFlag.AgentContent,
    description: 'Content generation capability.',
    defaultEnabled: true,
    introducedIn: 'phase-4',
  },
  {
    key: FeatureFlag.HermesReflection,
    description: 'Hermes critiques its own output before returning it. Costs an extra model call.',
    defaultEnabled: true,
    introducedIn: 'phase-1',
  },
  {
    key: FeatureFlag.HermesPlanner,
    description: 'Legacy unused planner flag retained for compatibility; no runtime caller.',
    defaultEnabled: true,
    introducedIn: 'phase-1',
  },
  {
    key: FeatureFlag.SemanticMemory,
    description: 'RAG retrieval over the CPA playbook and SOPs.',
    // Off by default: the Phase 1 implementation is a null adapter, so enabling
    // it would silently return no context rather than fail loudly.
    defaultEnabled: false,
    introducedIn: 'phase-1',
  },
  {
    key: FeatureFlag.InsightsEngine,
    description: 'Generate insights from domain events and inject them into Hermes context.',
    defaultEnabled: true,
    introducedIn: 'phase-1',
  },
  {
    key: FeatureFlag.AiBudgetEnforcement,
    description: 'Refuse model calls once an organization exceeds its hard budget limit.',
    defaultEnabled: true,
    introducedIn: 'phase-1',
  },
  {
    key: FeatureFlag.ChatStreaming,
    description: 'Server-sent-event streaming on /v1/chat/completions.',
    defaultEnabled: true,
    introducedIn: 'phase-1',
  },
];
