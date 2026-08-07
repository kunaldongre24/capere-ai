import { Logger } from '@nestjs/common';
import type { AppConfig } from '../../shared/config';
import {
  LlmProviderError,
  type LlmCompletion,
  type LlmCompletionRequest,
  type LlmMessage,
  type LlmProvider,
  type LlmStreamChunk,
  type LlmToolCall,
} from '../llm-provider.port';
import { MODEL_PRICING, costMicroUsd, hasKnownPricing } from './model-pricing';

/**
 * OpenRouter adapter.
 *
 * OpenRouter speaks the OpenAI chat-completions wire format across many
 * providers (Anthropic, OpenAI, Moonshot/Kimi, Nous/Hermes), which is why it
 * was chosen: one integration, many models, per-request routing. See ADR-0005.
 *
 * Notable behaviours this adapter is responsible for:
 *
 * - **Cost.** OpenRouter returns usage tokens but not always a cost, and cost
 *   varies per model. We compute it from a local pricing table into exact
 *   micro-USD integers rather than trusting a float from the wire.
 * - **Error classification.** Upstream failures are mapped to a small set of
 *   codes with an explicit `retryable` flag, because the model router needs to
 *   decide whether trying the next model in the chain could help. A 400 is not
 *   worth retrying; a 429 or 503 is.
 * - **Timeouts.** An LLM call can hang far longer than any user will wait, so
 *   every request carries an AbortController deadline.
 */
export class OpenRouterProvider implements LlmProvider {
  readonly name = 'openrouter';
  private readonly logger = new Logger(OpenRouterProvider.name);
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: AppConfig) {
    this.apiKey = config.openRouter.apiKey;
    this.baseUrl = config.openRouter.baseUrl.replace(/\/$/, '');
    this.timeoutMs = config.openRouter.timeoutMs;

    if (!this.apiKey) {
      throw new Error(
        'OpenRouterProvider constructed without an API key. ' +
          'The module should bind FakeLlmProvider when OPENROUTER_API_KEY is unset.',
      );
    }

    // Calls to an unpriced model fall back to a pessimistic rate, so spend is
    // over-reported rather than under-reported. Worth surfacing at boot: it
    // means the pricing table needs updating, not that billing is broken.
    const unpriced = [
      ...config.openRouter.models.general,
      ...config.openRouter.models.analytics,
      ...config.openRouter.models.cheap,
    ].filter((model) => !hasKnownPricing(model));

    if (unpriced.length > 0) {
      this.logger.warn(
        `No pricing table entry for: ${[...new Set(unpriced)].join(', ')}. ` +
          'Cost will be estimated at the pessimistic fallback rate. ' +
          'Add them to model-pricing.ts.',
      );
    }
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletion> {
    const response = await this.post(request, false);
    const body = (await response.json()) as OpenRouterResponse;

    const choice = body.choices?.[0];
    if (!choice) {
      throw new LlmProviderError('OpenRouter returned no choices', 'server_error', true);
    }

    const servedModel = body.model ?? request.model;
    const usage = body.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    return {
      servedModel,
      content: choice.message?.content ?? '',
      toolCalls: this.mapToolCalls(choice.message?.tool_calls),
      usage: {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
        costMicroUsd: costMicroUsd(servedModel, usage.prompt_tokens, usage.completion_tokens),
      },
      finishReason: this.mapFinishReason(choice.finish_reason),
    };
  }

  async *stream(request: LlmCompletionRequest): AsyncIterable<LlmStreamChunk> {
    const response = await this.post(request, true);

    if (!response.body) {
      throw new LlmProviderError('OpenRouter returned no response body', 'server_error', true);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let servedModel = request.model;
    let promptTokens = 0;
    let completionTokens = 0;
    let finishReason: LlmCompletion['finishReason'] = 'stop';
    // Tool calls arrive as fragments across chunks and must be reassembled by
    // index before they can be parsed.
    const toolAccumulator = new Map<number, { id: string; name: string; args: string }>();

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE frames are newline-delimited; a frame can straddle chunks, so keep
        // the trailing partial line in the buffer.
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;

          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') continue;

          let parsed: OpenRouterStreamChunk;
          try {
            parsed = JSON.parse(data) as OpenRouterStreamChunk;
          } catch {
            // OpenRouter sends periodic ': OPENROUTER PROCESSING' comments and
            // occasional keep-alives; skipping unparseable frames is correct.
            continue;
          }

          if (parsed.model) servedModel = parsed.model;
          if (parsed.usage) {
            promptTokens = parsed.usage.prompt_tokens;
            completionTokens = parsed.usage.completion_tokens;
          }

          const choice = parsed.choices?.[0];
          if (!choice) continue;

          if (choice.finish_reason) {
            finishReason = this.mapFinishReason(choice.finish_reason);
          }

          for (const fragment of choice.delta?.tool_calls ?? []) {
            const index = fragment.index ?? 0;
            const existing = toolAccumulator.get(index) ?? { id: '', name: '', args: '' };
            toolAccumulator.set(index, {
              id: fragment.id ?? existing.id,
              name: fragment.function?.name ?? existing.name,
              args: existing.args + (fragment.function?.arguments ?? ''),
            });
          }

          const delta = choice.delta?.content;
          if (delta) {
            yield { delta };
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const toolCalls: LlmToolCall[] = [...toolAccumulator.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, t]) => ({ id: t.id, name: t.name, arguments: t.args || '{}' }));

    yield {
      delta: '',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        costMicroUsd: costMicroUsd(servedModel, promptTokens, completionTokens),
      },
      finishReason,
      servedModel,
    };
  }

  private async post(request: LlmCompletionRequest, stream: boolean): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    // Honour a caller-supplied signal in addition to our own deadline.
    const onAbort = (): void => controller.abort();
    request.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          // OpenRouter uses these for attribution on its dashboard.
          'HTTP-Referer': 'https://capere.ai',
          'X-Title': 'Capere AI',
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages.map((m) => this.mapMessage(m)),
          ...(request.tools?.length
            ? {
                tools: request.tools.map((t) => ({
                  type: 'function',
                  function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters,
                  },
                })),
              }
            : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
          ...(request.responseFormat ? { response_format: request.responseFormat } : {}),
          ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw await this.errorFor(response);
      }

      return response;
    } catch (error) {
      if (error instanceof LlmProviderError) throw error;

      if (error instanceof Error && error.name === 'AbortError') {
        const aborted = request.signal?.aborted ?? false;
        throw new LlmProviderError(
          aborted ? 'Request aborted by caller' : `OpenRouter timed out after ${this.timeoutMs}ms`,
          aborted ? 'aborted' : 'timeout',
          !aborted,
        );
      }

      throw new LlmProviderError(
        `OpenRouter request failed: ${error instanceof Error ? error.message : String(error)}`,
        'server_error',
        true,
      );
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Maps an HTTP failure to a classified, retryability-tagged error.
   *
   * The distinction drives the model router: retrying a malformed request or a
   * bad API key against every fallback model wastes time and money, while a
   * 429 or 503 genuinely may succeed on the next model.
   */
  private async errorFor(response: Response): Promise<LlmProviderError> {
    let detail = '';
    try {
      detail = (await response.text()).slice(0, 500);
    } catch {
      // Body already consumed or unreadable — status alone is enough.
    }

    const message = `OpenRouter ${response.status}: ${detail || response.statusText}`;

    switch (response.status) {
      case 400:
        return new LlmProviderError(message, 'invalid_request', false, 400);
      case 401:
      case 403:
        return new LlmProviderError(message, 'auth_failed', false, response.status);
      case 404:
        // An unknown model id — a different model may well work.
        return new LlmProviderError(message, 'model_unavailable', true, 404);
      case 408:
        return new LlmProviderError(message, 'timeout', true, 408);
      case 429:
        return new LlmProviderError(message, 'rate_limited', true, 429);
      case 502:
      case 503:
      case 504:
        return new LlmProviderError(message, 'model_unavailable', true, response.status);
      default:
        return new LlmProviderError(
          message,
          'server_error',
          response.status >= 500,
          response.status,
        );
    }
  }

  private mapMessage(message: LlmMessage): Record<string, unknown> {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        content: message.content,
        tool_call_id: message.toolCallId,
        ...(message.name ? { name: message.name } : {}),
      };
    }

    if (message.toolCalls?.length) {
      return {
        role: message.role,
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
      };
    }

    return { role: message.role, content: message.content };
  }

  private mapToolCalls(calls?: OpenRouterToolCall[]): LlmToolCall[] {
    if (!calls?.length) return [];
    return calls.map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments || '{}',
    }));
  }

  private mapFinishReason(reason?: string | null): LlmCompletion['finishReason'] {
    switch (reason) {
      case 'stop':
      case 'end_turn':
        return 'stop';
      case 'length':
      case 'max_tokens':
        return 'length';
      case 'tool_calls':
      case 'function_call':
        return 'tool_calls';
      case 'content_filter':
        return 'content_filter';
      default:
        return 'stop';
    }
  }

  /** Models this adapter knows pricing for — used by a startup sanity check. */
  static knownModels(): string[] {
    return Object.keys(MODEL_PRICING);
  }
}

// --- Wire types (OpenAI-compatible subset) ---------------------------------

interface OpenRouterToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

interface OpenRouterUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface OpenRouterResponse {
  model?: string;
  usage?: OpenRouterUsage;
  choices?: Array<{
    message?: { content?: string; tool_calls?: OpenRouterToolCall[] };
    finish_reason?: string | null;
  }>;
}

interface OpenRouterStreamChunk {
  model?: string;
  usage?: OpenRouterUsage;
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
}
