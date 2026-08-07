import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../shared/config';
import type { AgentKind } from '../../shared/database';
import { AppException, ErrorCode } from '../../shared/http';
import { BudgetService } from '../budgets/budget.service';
import {
  LLM_PROVIDER,
  LlmProviderError,
  type LlmCompletion,
  type LlmCompletionRequest,
  type LlmProvider,
  type LlmStreamChunk,
} from '../llm-provider.port';
import { UsageService } from '../usage/usage.service';

/**
 * Task types map to model fallback chains.
 *
 * Routing by TASK rather than by hard-coded model name means the model choice
 * for "cheap classification" can change in config without touching call sites.
 */
export type TaskType = 'general' | 'analytics' | 'cheap';

export interface RoutedCallOptions {
  organizationId: string;
  taskType?: TaskType;
  /** Overrides the chain entirely — used when a caller needs a specific model. */
  model?: string;
  sessionId?: string;
  userId?: string;
  agent?: AgentKind;
  promptName?: string;
  promptVersion?: number;
  promptChecksum?: string;
  metadata?: Record<string, unknown>;
}

/**
 * The single entry point for every model call in Capere.
 *
 * Responsibilities, in order:
 *
 *   1. **Budget gate.** Refuse before spending if the organization is over its
 *      enforced hard limit. Checked first, because a check after the call cannot
 *      prevent the cost it exists to cap.
 *   2. **Fallback chain.** Try each model in the task's chain until one succeeds.
 *      Only RETRYABLE failures advance the chain — a malformed request or bad
 *      credential fails identically on every model, so retrying wastes time and
 *      money and delays a real error reaching the caller.
 *   3. **Ledger.** Record every attempt, success or failure, with the model that
 *      actually served it and which fallback position that was.
 *   4. **Threshold evaluation.** Re-check budgets after recording, emitting an
 *      alert event once per period if a threshold was crossed.
 *
 * Nothing else in the codebase should call an LlmProvider directly — doing so
 * bypasses budgets and the ledger.
 */
@Injectable()
export class ModelRouterService {
  private readonly logger = new Logger(ModelRouterService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LLM_PROVIDER) private readonly provider: LlmProvider,
    private readonly usage: UsageService,
    private readonly budgets: BudgetService,
  ) {}

  /** Non-streaming completion with budget enforcement and fallback. */
  async complete(
    request: Omit<LlmCompletionRequest, 'model'> & { model?: string },
    options: RoutedCallOptions,
  ): Promise<LlmCompletion> {
    await this.budgets.assertWithinBudget(options.organizationId);

    const chain = this.chainFor(options);
    let lastError: unknown;

    for (let index = 0; index < chain.length; index += 1) {
      const model = chain[index];
      const startedAt = Date.now();

      try {
        const completion = await this.provider.complete({ ...request, model });

        await this.usage.record({
          organizationId: options.organizationId,
          sessionId: options.sessionId,
          userId: options.userId,
          agent: options.agent,
          requestedModel: model,
          servedModel: completion.servedModel,
          provider: this.provider.name,
          taskType: options.taskType ?? 'general',
          promptName: options.promptName,
          promptVersion: options.promptVersion,
          promptChecksum: options.promptChecksum,
          usage: completion.usage,
          latencyMs: Date.now() - startedAt,
          fallbackIndex: index,
          succeeded: true,
          metadata: options.metadata,
        });

        // After recording, so it reads the updated ledger.
        await this.budgets.evaluateAfterUsage(options.organizationId);

        if (index > 0) {
          this.logger.warn(
            `Model ${chain[0]} unavailable; served by fallback ${model} (position ${index}).`,
          );
        }

        return completion;
      } catch (error) {
        lastError = error;
        await this.recordFailure(model, index, startedAt, error, options);

        if (!this.shouldTryNext(error)) break;
      }
    }

    throw this.translate(lastError, chain);
  }

  /**
   * Streaming completion.
   *
   * Fallback applies only to the CONNECTION attempt. Once the first chunk has
   * been yielded, the response is already flowing to the client and switching
   * models mid-stream would corrupt it — so a mid-stream failure surfaces rather
   * than silently splicing two different models' output together.
   */
  async *stream(
    request: Omit<LlmCompletionRequest, 'model'> & { model?: string },
    options: RoutedCallOptions,
  ): AsyncIterable<LlmStreamChunk> {
    await this.budgets.assertWithinBudget(options.organizationId);

    const chain = this.chainFor(options);
    let lastError: unknown;

    for (let index = 0; index < chain.length; index += 1) {
      const model = chain[index];
      const startedAt = Date.now();
      let started = false;

      try {
        for await (const chunk of this.provider.stream({ ...request, model })) {
          started = true;

          if (chunk.usage) {
            await this.usage.record({
              organizationId: options.organizationId,
              sessionId: options.sessionId,
              userId: options.userId,
              agent: options.agent,
              requestedModel: model,
              servedModel: chunk.servedModel ?? model,
              provider: this.provider.name,
              taskType: options.taskType ?? 'general',
              promptName: options.promptName,
              promptVersion: options.promptVersion,
              promptChecksum: options.promptChecksum,
              usage: chunk.usage,
              latencyMs: Date.now() - startedAt,
              fallbackIndex: index,
              succeeded: true,
              metadata: options.metadata,
            });

            await this.budgets.evaluateAfterUsage(options.organizationId);
          }

          yield chunk;
        }

        return;
      } catch (error) {
        lastError = error;
        await this.recordFailure(model, index, startedAt, error, options);

        // Cannot fall back once bytes have reached the client.
        if (started || !this.shouldTryNext(error)) break;
      }
    }

    throw this.translate(lastError, chain);
  }

  /** The ordered model chain for this call. */
  private chainFor(options: RoutedCallOptions): string[] {
    if (options.model) return [options.model];

    const models = this.config.openRouter.models;
    switch (options.taskType ?? 'general') {
      case 'analytics':
        return [...models.analytics];
      case 'cheap':
        return [...models.cheap];
      default:
        return [...models.general];
    }
  }

  /**
   * Only retryable provider errors advance the chain.
   *
   * A 400 or 401 will fail identically on every model, so trying the rest just
   * delays the error. Non-provider errors (a bug in our own code) are never
   * retried either — they are not the model's fault.
   */
  private shouldTryNext(error: unknown): boolean {
    return error instanceof LlmProviderError && error.retryable;
  }

  private async recordFailure(
    model: string,
    index: number,
    startedAt: number,
    error: unknown,
    options: RoutedCallOptions,
  ): Promise<void> {
    const code = error instanceof LlmProviderError ? error.code : 'unknown';

    try {
      await this.usage.record({
        organizationId: options.organizationId,
        sessionId: options.sessionId,
        userId: options.userId,
        agent: options.agent,
        requestedModel: model,
        servedModel: model,
        provider: this.provider.name,
        taskType: options.taskType ?? 'general',
        promptName: options.promptName,
        promptVersion: options.promptVersion,
        promptChecksum: options.promptChecksum,
        // A failed call may still have consumed upstream tokens, but the
        // provider does not report them — record zeros rather than guessing.
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, costMicroUsd: 0 },
        latencyMs: Date.now() - startedAt,
        fallbackIndex: index,
        succeeded: false,
        errorCode: code,
        metadata: options.metadata,
      });
    } catch (recordError) {
      // Never let a ledger write failure mask the original provider error.
      this.logger.error(
        `Failed to record usage for a failed call: ` +
          `${recordError instanceof Error ? recordError.message : String(recordError)}`,
      );
    }

    this.logger.warn(`Model ${model} failed (${code}): ${(error as Error).message}`);
  }

  private translate(error: unknown, chain: string[]): AppException {
    if (error instanceof AppException) return error;

    if (error instanceof LlmProviderError) {
      if (error.code === 'auth_failed') {
        // An operator problem, not a caller problem — do not echo the provider's
        // message, which can contain key fragments.
        return AppException.serviceUnavailable(
          ErrorCode.SERVICE_UNAVAILABLE,
          'The AI provider rejected our credentials. This is a server configuration problem.',
        );
      }
      if (error.code === 'rate_limited') {
        return AppException.tooManyRequests(
          'The AI provider is rate limiting requests. Please retry shortly.',
        );
      }
      if (error.code === 'invalid_request') {
        return AppException.badRequest(
          ErrorCode.BAD_REQUEST,
          `Invalid model request: ${error.message}`,
        );
      }
      return AppException.serviceUnavailable(
        ErrorCode.MODEL_UNAVAILABLE,
        `No model in the fallback chain could serve this request (tried: ${chain.join(', ')}).`,
      );
    }

    return AppException.internal(
      `Model call failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
