import { Injectable, Logger, Optional } from '@nestjs/common';
import type { OrgRole } from '../shared/database';
import { FeatureFlag, FeatureFlagService } from '../feature-flags';
import { AppException, ErrorCode } from '../shared/http';
import type { LlmMessage } from '../llm';
import { ContextBuilder } from './context/context-builder';
import { ToolExecutionService } from './execution/tool-execution.service';
import { MemoryService } from './memory/memory.service';
import { PromptRegistryService } from './prompts/prompt-registry.service';
import { ResponseReviewService } from './review/response-review.service';
import type { ToolResult } from './tools/tool.interface';
import { ToolRegistry } from './tools/tool-registry';
import { CapabilityRouter, type IntelligenceCapability } from './capability-router.service';

export interface GenerateChatResponseCommand {
  readonly organizationId: string;
  readonly userId?: string;
  readonly role: OrgRole;
  readonly capability: IntelligenceCapability;
  readonly message: string;
  readonly sessionId?: string;
  readonly sessionOwnerId?: string;
  readonly machineAccess?: boolean;
  readonly priorMessages?: LlmMessage[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly maxIterations?: number;
  readonly signal?: AbortSignal;
  readonly ephemeral: boolean;
}

export interface ChatResponseResult {
  readonly content: string;
  readonly sessionId?: string;
  readonly toolResults: ToolResult[];
  readonly modelCalls: number;
  readonly reviewed: boolean;
  readonly revised: boolean;
}

@Injectable()
export class GenerateChatResponseUseCase {
  private readonly logger = new Logger(GenerateChatResponseUseCase.name);
  constructor(
    private readonly capabilities: CapabilityRouter,
    private readonly context: ContextBuilder,
    private readonly conversations: MemoryService,
    private readonly prompts: PromptRegistryService,
    private readonly tools: ToolExecutionService,
    private readonly reviewer: ResponseReviewService,
    private readonly flags: FeatureFlagService,
    @Optional() private readonly toolRegistry?: ToolRegistry,
  ) {}

  async execute(command: GenerateChatResponseCommand): Promise<ChatResponseResult> {
    const policy = this.capabilities.resolve(command.capability);
    if (
      policy.enabledFlag &&
      !(await this.flags.isEnabled(command.organizationId, policy.enabledFlag))
    )
      throw AppException.forbidden(
        ErrorCode.FORBIDDEN,
        `${command.capability} capability is disabled`,
      );
    const sessionId = command.ephemeral
      ? command.sessionId
      : (command.sessionId ??
        (await this.conversations.createSession({
          organizationId: command.organizationId,
          userId: command.userId,
          agent: policy.agent,
          title: command.message.slice(0, 80),
        })));
    if (command.sessionId)
      await this.conversations.assertSessionAccess({
        organizationId: command.organizationId,
        sessionId: command.sessionId,
        userId: command.sessionOwnerId ?? command.userId,
        machineAccess: command.machineAccess,
      });

    const [organizationContext, memory] = await Promise.all([
      this.context.forOrganization(command.organizationId),
      this.conversations.snapshot({
        organizationId: command.organizationId,
        sessionId,
        semanticQuery: command.message,
      }),
    ]);
    const prompt = await this.prompts.resolve(policy.systemPrompt, command.organizationId, {
      organizationName: organizationContext.organizationName,
    });
    const history: LlmMessage[] = memory.conversation.map((turn) => ({
      role: turn.role,
      content: turn.content,
      ...(turn.toolCallId ? { toolCallId: turn.toolCallId } : {}),
      ...(turn.toolName ? { name: turn.toolName } : {}),
    }));
    if (sessionId && !command.ephemeral)
      await this.conversations.append({
        sessionId,
        organizationId: command.organizationId,
        role: 'user',
        content: command.message,
      });

    const toolsEnabled = await this.flags.isEnabled(
      command.organizationId,
      FeatureFlag.IntelligenceBoundedTools,
    );
    const preflight =
      toolsEnabled && this.requiresGbpGrounding(command.message) && this.toolRegistry?.has('get_gbp_summary')
        ? await this.toolRegistry.execute('get_gbp_summary', JSON.stringify({ days: 30 }), {
            organizationId: command.organizationId,
            userId: command.userId,
            role: command.role,
            sessionId,
            agent: policy.agent,
            signal: command.signal ?? new AbortController().signal,
          })
        : null;
    const liveSourceContext = preflight
      ? `\n\n## Mandatory live source check\nThe user asked about Google Business Profile, reviews, reputation, ratings, or the local profile. ` +
        `Capere checked get_gbp_summary before this model call. Treat this result as current evidence and do not infer availability from integration names alone.\n` +
        `Do not reveal internal location, integration, resource, OAuth, or provider identifiers. If the business profile says setupRequired, explain that this is a Capere administrator configuration and do not ask the client to connect Google. ` +
        `${preflight.ok ? JSON.stringify(preflight.output ?? null) : `The live check failed: ${preflight.error?.message ?? 'unknown error'}`}`
      : '';
    const result = await this.tools.run({
      organizationId: command.organizationId,
      userId: command.userId,
      role: command.role,
      sessionId,
      agent: policy.agent,
      taskType: policy.taskType,
      systemPrompt: `${prompt.content}\n\n${this.context.render(organizationContext, memory)}${liveSourceContext}`,
      messages: [
        ...(command.priorMessages ?? []),
        ...history,
        { role: 'user', content: command.message },
      ],
      temperature: command.temperature,
      maxTokens: command.maxTokens,
      maxIterations: command.maxIterations,
      allowMutatingTools: false,
      toolsEnabled,
      promptName: prompt.name,
      promptVersion: prompt.version,
      promptChecksum: prompt.checksum,
      signal: command.signal,
    });

    const groundedToolResults = preflight ? [preflight, ...result.toolResults] : result.toolResults;
    let content = result.content,
      reviewed = false,
      revised = false;
    if (
      await this.flags.isEnabled(command.organizationId, FeatureFlag.IntelligenceResponseReview)
    ) {
      const reviewPrompt = await this.prompts.resolve(
        'intelligence.response_review',
        command.organizationId,
      );
      const verdict = await this.reviewer.review({
        organizationId: command.organizationId,
        userId: command.userId,
        sessionId,
        agent: policy.agent,
        userRequest: command.message,
        draft: content,
        toolResults: groundedToolResults,
        reflectionPrompt: reviewPrompt.content,
        promptName: reviewPrompt.name,
        promptVersion: reviewPrompt.version,
        promptChecksum: reviewPrompt.checksum,
        signal: command.signal,
      });
      reviewed = true;
      if (!verdict.approved && verdict.revisedResponse) {
        content = verdict.revisedResponse;
        revised = true;
      }
    }
    if (sessionId && !command.ephemeral) {
      await this.persistTranscript(
        command.organizationId,
        sessionId,
        result.messages,
        2 + (command.priorMessages?.length ?? 0) + history.length,
      );
      await this.conversations.append({
        sessionId,
        organizationId: command.organizationId,
        role: 'assistant',
        content,
        metadata: {
          modelCalls: result.iterations,
          exhausted: result.exhausted,
          reviewed,
          revised,
          sources: [...new Set(groundedToolResults.filter((tool) => tool.ok).map((tool) => tool.toolName))],
        },
      });
    }
    this.logger.debug(
      `Generated stateless intelligence response in ${result.iterations} model call(s)`,
    );
    return {
      content,
      sessionId,
      toolResults: groundedToolResults,
      modelCalls: result.iterations,
      reviewed,
      revised,
    };
  }

  private requiresGbpGrounding(message: string): boolean {
    return /\b(?:gbp|google\s+business(?:\s+profile)?|google\s+reviews?|reviews?|ratings?|reputation|local\s+profile)\b/i.test(
      message,
    );
  }

  private async persistTranscript(
    organizationId: string,
    sessionId: string,
    messages: LlmMessage[],
    inputCount: number,
  ) {
    for (const message of messages.slice(inputCount)) {
      if (message.role === 'assistant' && message.toolCalls?.length) {
        for (const call of message.toolCalls) {
          let args: unknown;
          try {
            args = JSON.parse(call.arguments);
          } catch {
            args = undefined;
          }
          await this.conversations.append({
            organizationId,
            sessionId,
            role: 'assistant',
            content: message.content,
            toolCallId: call.id,
            toolName: call.name,
            ...(args === undefined ? {} : { toolArguments: args }),
          });
        }
      } else if (message.role === 'tool') {
        await this.conversations.append({
          organizationId,
          sessionId,
          role: 'tool',
          content: message.content,
          toolCallId: message.toolCallId,
          toolName: message.name,
        });
      }
    }
  }
}
