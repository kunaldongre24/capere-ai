import { createHash } from 'node:crypto';
import type {
  LlmCompletion,
  LlmCompletionRequest,
  LlmProvider,
  LlmStreamChunk,
  LlmToolCall,
} from '../llm-provider.port';

/**
 * Deterministic offline LLM provider.
 *
 * Not a loose mock — a second real implementation of `LlmProvider`, held to the
 * same contract test suite as the OpenRouter adapter. It exists so the entire
 * Hermes loop (plan -> context -> tools -> reason -> reflect) is developable and
 * CI-verifiable with no API key, no network, and no spend.
 *
 * DETERMINISM: output is derived from a hash of the request, so the same input
 * always produces the same output. A fake that returned random text would make
 * every orchestration assertion flaky and force tests to assert almost nothing.
 *
 * SCRIPTING: `script()` queues exact responses for a test that needs a specific
 * model reply — e.g. "return a tool call, then a final answer" to exercise the
 * multi-turn tool loop.
 */
export class FakeLlmProvider implements LlmProvider {
  readonly name = 'fake';

  /** Queued responses, consumed FIFO by `complete`/`stream`. */
  private readonly scripted: Array<Partial<LlmCompletion>> = [];
  /** Every request received, for assertions about what was actually sent. */
  readonly calls: LlmCompletionRequest[] = [];
  /** When set, the next call rejects with this error. */
  private failure?: Error;

  /** Queues responses returned in order before falling back to derived output. */
  script(...responses: Array<Partial<LlmCompletion>>): this {
    this.scripted.push(...responses);
    return this;
  }

  /** Makes the next call throw — used to test fallback and retry paths. */
  failNext(error: Error): this {
    this.failure = error;
    return this;
  }

  reset(): void {
    this.scripted.length = 0;
    this.calls.length = 0;
    this.failure = undefined;
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletion> {
    this.calls.push(request);

    if (this.failure) {
      const error = this.failure;
      this.failure = undefined;
      throw error;
    }

    const scripted = this.scripted.shift();
    const base = this.derive(request);

    return { ...base, ...scripted, usage: scripted?.usage ?? base.usage };
  }

  async *stream(request: LlmCompletionRequest): AsyncIterable<LlmStreamChunk> {
    const completion = await this.complete(request);

    // Chunk on word boundaries so a consumer that reassembles the stream gets
    // exactly the non-streaming content back — a property worth asserting.
    const words = completion.content.length > 0 ? completion.content.split(' ') : [];

    for (let i = 0; i < words.length; i += 1) {
      yield { delta: i === 0 ? words[i] : ` ${words[i]}` };
    }

    yield {
      delta: '',
      toolCalls: completion.toolCalls.length > 0 ? completion.toolCalls : undefined,
      usage: completion.usage,
      finishReason: completion.finishReason,
      servedModel: completion.servedModel,
    };
  }

  /**
   * Builds a stable response from the request.
   *
   * Token counts approximate the ~4-characters-per-token rule so budget and
   * cost accounting are exercised with plausible magnitudes rather than zeros.
   */
  private derive(request: LlmCompletionRequest): LlmCompletion {
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          model: request.model,
          messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
          tools: request.tools?.map((t) => t.name),
        }),
      )
      .digest('hex');

    const lastUser = [...request.messages].reverse().find((m) => m.role === 'user');
    const content =
      `[fake:${fingerprint.slice(0, 8)}] ` +
      (lastUser ? `Responding to: ${lastUser.content.slice(0, 200)}` : 'No user message provided.');

    const promptChars = request.messages.reduce((sum, m) => sum + m.content.length, 0);
    const promptTokens = Math.max(1, Math.ceil(promptChars / 4));
    const completionTokens = Math.max(1, Math.ceil(content.length / 4));

    // If tools were offered, deterministically call the first one roughly half
    // the time (by fingerprint parity) so both branches of the tool loop are
    // reachable without scripting.
    const shouldCallTool =
      (request.tools?.length ?? 0) > 0 && parseInt(fingerprint.slice(0, 2), 16) % 2 === 0;

    const toolCalls: LlmToolCall[] = shouldCallTool
      ? [
          {
            id: `call_${fingerprint.slice(0, 12)}`,
            name: request.tools![0].name,
            arguments: '{}',
          },
        ]
      : [];

    return {
      servedModel: request.model,
      content: shouldCallTool ? '' : content,
      toolCalls,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        // 1 micro-USD per token: round numbers make budget assertions readable.
        costMicroUsd: promptTokens + completionTokens,
      },
      finishReason: shouldCallTool ? 'tool_calls' : 'stop',
    };
  }
}
