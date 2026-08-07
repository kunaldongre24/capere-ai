import { Injectable, Logger } from '@nestjs/common';
import type { AgentKind, OrgRole } from '../../shared/database';
import type { LlmMessage } from '../../llm';
import { ModelRouterService, type TaskType } from '../../llm';
import { ToolRegistry } from '../tools/tool-registry';
import type { ToolContext, ToolResult } from '../tools/tool.interface';

export interface ReasoningRequest {
  readonly organizationId: string;
  readonly userId?: string;
  readonly role: OrgRole;
  readonly sessionId?: string;
  readonly agent: AgentKind;
  readonly systemPrompt: string;
  readonly messages: LlmMessage[];
  readonly taskType?: TaskType;
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly maxIterations?: number;
  readonly allowMutatingTools?: boolean;
  readonly toolsEnabled?: boolean;
  readonly promptName?: string;
  readonly promptVersion?: number;
  readonly promptChecksum?: string;
  readonly signal?: AbortSignal;
}

export interface ReasoningResult {
  readonly content: string;
  /** Full message history including tool calls and results, for persistence. */
  readonly messages: LlmMessage[];
  readonly toolResults: ToolResult[];
  readonly iterations: number;
  /** True when the loop hit its iteration cap rather than finishing. */
  readonly exhausted: boolean;
}

/**
 * The stateless intelligence tool-execution loop.
 *
 * Runs the model until it produces a final answer, executing any tools it asks
 * for along the way:
 *
 *   call model -> tool calls? -> execute -> feed results back -> repeat
 *
 * THE ITERATION CAP IS A SAFETY MECHANISM, NOT A TUNING KNOB. Without it a
 * model that keeps requesting tools loops forever, and each turn costs money
 * and adds latency. When the cap is hit, the loop makes one final call with
 * tools withheld, which forces a text answer instead of returning nothing.
 *
 * TOOL FAILURES ARE FED BACK, NOT THROWN. A failed ToolResult becomes a tool
 * message the model can read and adapt to — "the GA4 integration is not
 * connected" is something it can work with, whereas an exception would abort a
 * conversation that could still be useful.
 */
@Injectable()
export class ToolExecutionService {
  private readonly logger = new Logger(ToolExecutionService.name);
  private static readonly DEFAULT_MAX_ITERATIONS = 8;

  constructor(
    private readonly modelRouter: ModelRouterService,
    private readonly tools: ToolRegistry,
  ) {}

  async run(request: ReasoningRequest): Promise<ReasoningResult> {
    const maxIterations = request.maxIterations ?? ToolExecutionService.DEFAULT_MAX_ITERATIONS;

    const messages: LlmMessage[] = [
      { role: 'system', content: request.systemPrompt },
      ...request.messages,
    ];

    const toolResults: ToolResult[] = [];
    const descriptors =
      request.toolsEnabled === false
        ? []
        : this.tools.descriptorsFor(request.role, {
            includeMutating: request.allowMutatingTools ?? true,
            agent: request.agent,
          });

    let iterations = 0;

    while (iterations < maxIterations) {
      iterations += 1;

      const completion = await this.modelRouter.complete(
        {
          messages,
          tools: descriptors.length > 0 ? descriptors : undefined,
          signal: request.signal,
          temperature: request.temperature,
          maxTokens: request.maxTokens,
        },
        {
          organizationId: request.organizationId,
          userId: request.userId,
          sessionId: request.sessionId,
          agent: request.agent,
          taskType: request.taskType,
          model: request.model,
          promptName: request.promptName,
          promptVersion: request.promptVersion,
          promptChecksum: request.promptChecksum,
          metadata: { iteration: iterations },
        },
      );

      // No tool calls: this is the final answer.
      if (completion.toolCalls.length === 0) {
        messages.push({ role: 'assistant', content: completion.content });
        return {
          content: completion.content,
          messages,
          toolResults,
          iterations,
          exhausted: false,
        };
      }

      // Record the assistant's tool-call request before the results, or the
      // provider will reject the next request as malformed — a tool result with
      // no preceding call is a protocol violation.
      messages.push({
        role: 'assistant',
        content: completion.content,
        toolCalls: completion.toolCalls,
      });

      const toolContext: ToolContext = {
        organizationId: request.organizationId,
        userId: request.userId,
        role: request.role,
        sessionId: request.sessionId,
        agent: request.agent,
        signal: request.signal ?? new AbortController().signal,
      };

      // Independent calls run concurrently: a model asking for three metrics
      // should not wait for them serially.
      const results = await Promise.all(
        completion.toolCalls.map((call) =>
          this.tools
            .execute(call.name, call.arguments, toolContext)
            .then((result) => ({ call, result })),
        ),
      );

      for (const { call, result } of results) {
        toolResults.push(result);
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: this.renderToolResult(result),
        });
      }
    }

    // Cap reached. Ask once more with NO tools so the model must answer in text
    // rather than requesting yet another call.
    this.logger.warn(
      `Reasoning loop hit its ${maxIterations}-iteration cap for organization ` +
        `${request.organizationId}; forcing a final answer.`,
    );

    const final = await this.modelRouter.complete(
      {
        messages: [
          ...messages,
          {
            role: 'user',
            content:
              'You have reached the maximum number of tool calls for this request. ' +
              'Answer now using only the information you have already gathered. ' +
              'State plainly anything you were unable to determine.',
          },
        ],
        signal: request.signal,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
      },
      {
        organizationId: request.organizationId,
        userId: request.userId,
        sessionId: request.sessionId,
        agent: request.agent,
        taskType: request.taskType,
        model: request.model,
        promptName: request.promptName,
        promptVersion: request.promptVersion,
        promptChecksum: request.promptChecksum,
        metadata: { iteration: iterations + 1, forcedFinal: true },
      },
    );

    messages.push({ role: 'assistant', content: final.content });

    return {
      content: final.content,
      messages,
      toolResults,
      iterations: iterations + 1,
      exhausted: true,
    };
  }

  /**
   * Renders a tool result as the content of a tool message.
   *
   * Failures are rendered as readable text rather than raw JSON so the model
   * reliably understands what went wrong — models act on a plain sentence far
   * more consistently than on a nested error object.
   */
  private renderToolResult(result: ToolResult): string {
    if (result.ok) {
      return typeof result.output === 'string'
        ? result.output
        : JSON.stringify(result.output ?? null);
    }

    const detail = result.error?.details ? ` Details: ${JSON.stringify(result.error.details)}` : '';

    return `ERROR (${result.error?.code}): ${result.error?.message}${detail}`;
  }
}
