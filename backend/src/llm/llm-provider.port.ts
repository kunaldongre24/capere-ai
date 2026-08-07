/**
 * The LLM provider port.
 *
 * Every model call in Capere goes through this interface. Two implementations
 * exist and both must satisfy the same contract test suite:
 *
 *   - `OpenRouterProvider` — the real adapter.
 *   - `FakeLlmProvider`    — deterministic, offline, no API key.
 *
 * This is what makes the orchestration loop developable and CI-testable with no
 * credentials and no spend. It is not a mock in the loose sense: it is a second
 * real implementation held to an identical contract, so swapping in the live
 * provider is verified rather than hoped.
 *
 * Deliberately provider-agnostic — no OpenRouter or OpenAI types leak through.
 * When a second gateway is added, only a new adapter is written.
 */

export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmMessage {
  role: LlmRole;
  content: string;
  /** Set on assistant messages that request tool calls. */
  toolCalls?: LlmToolCall[];
  /** Set on tool-result messages, matching the originating call. */
  toolCallId?: string;
  /** Optional name, used for tool results. */
  name?: string;
}

export interface LlmToolCall {
  id: string;
  name: string;
  /** Raw JSON string as emitted by the model — parsed and validated by the
   *  tool registry, never trusted here. */
  arguments: string;
}

/** A tool offered to the model, in provider-neutral form. */
export interface LlmToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the parameters. */
  parameters: Record<string, unknown>;
}

export interface LlmCompletionRequest {
  model: string;
  messages: LlmMessage[];
  tools?: LlmToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  /** Ask the model to emit JSON matching this schema, when supported. */
  responseFormat?: { type: 'json_object' } | { type: 'text' };
  /** Abort signal so a slow call can be cancelled with the request. */
  signal?: AbortSignal;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /**
   * Cost in MICRO-USD (millionths of a dollar) as an exact integer.
   * Never a float: per-call costs are fractions of a cent, and accumulating
   * floating-point money across millions of calls drifts.
   */
  costMicroUsd: number;
}

export interface LlmCompletion {
  /** The model that actually served the request — may differ from the one
   *  requested if the gateway rerouted it. */
  servedModel: string;
  content: string;
  toolCalls: LlmToolCall[];
  usage: LlmUsage;
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error';
}

/** One chunk of a streaming completion. */
export interface LlmStreamChunk {
  /** Incremental text. Empty on non-text chunks. */
  delta: string;
  toolCalls?: LlmToolCall[];
  /** Present only on the final chunk. */
  usage?: LlmUsage;
  finishReason?: LlmCompletion['finishReason'];
  servedModel?: string;
}

export interface LlmProvider {
  /** Stable identifier, e.g. 'openrouter' or 'fake'. Recorded on usage events. */
  readonly name: string;

  complete(request: LlmCompletionRequest): Promise<LlmCompletion>;

  /**
   * Streaming completion. Yields incremental chunks; the final chunk carries
   * usage and finishReason.
   */
  stream(request: LlmCompletionRequest): AsyncIterable<LlmStreamChunk>;
}

/** DI token — the concrete binding is chosen by config at module setup. */
export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

/** Thrown when a provider call fails in a way worth distinguishing. */
export class LlmProviderError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'rate_limited'
      | 'timeout'
      | 'model_unavailable'
      | 'invalid_request'
      | 'auth_failed'
      | 'server_error'
      | 'aborted',
    /** True when retrying the same request against a fallback may succeed. */
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmProviderError';
  }
}
