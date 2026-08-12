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
    const preflightTool = this.requiresGbpGrounding(command.message)
      ? 'get_gbp_summary'
      : policy.agent === 'cmo' && this.requiresCmoBusinessGrounding(command.message)
        ? 'get_cmo_business_summary'
        : null;
    const preflight =
      toolsEnabled && preflightTool && this.toolRegistry?.has(preflightTool)
        ? await this.toolRegistry.execute(preflightTool, JSON.stringify({ days: preflightTool === 'get_gbp_summary' ? 30 : 7 }), {
            organizationId: command.organizationId,
            userId: command.userId,
            role: command.role,
            sessionId,
            agent: policy.agent,
            signal: command.signal ?? new AbortController().signal,
          })
        : null;
    // A prior GBP answer may have been generated before the public-profile
    // grounding rules were added (and may contain stale permission guidance or
    // internal identifiers). Do not let those assistant/tool messages compete
    // with the current live profile check. Keep the user's prior questions for
    // conversational context, while making the live result authoritative.
    const promptHistory = preflight
      ? history.filter((turn) => turn.role === 'user').slice(-6)
      : history;
    const promptPriorMessages = preflight
      ? (command.priorMessages ?? []).filter((turn) => turn.role === 'user').slice(-6)
      : (command.priorMessages ?? []);
    const liveSourceContext = preflight
      ? preflightTool === 'get_gbp_summary'
        ? `\n\n## Mandatory live source check\nThe user asked about Google Business Profile, reviews, reputation, ratings, or the local profile. ` +
          `Capere checked get_gbp_summary before this model call. Treat this result as current evidence and do not infer availability from integration names alone.\n` +
          `Do not reveal internal location, integration, resource, OAuth, or provider identifiers. If the business profile says setupRequired, explain that this is a Capere administrator configuration and do not ask the client to connect Google. ` +
          `${preflight.ok ? JSON.stringify(preflight.output ?? null) : `The live check failed: ${preflight.error?.message ?? 'unknown error'}`}`
        : `\n\n## Mandatory multi-channel business check\nThe user asked for broad priorities or an overall business assessment. ` +
          `Capere checked website analytics, Search Console, GoHighLevel pipeline and operations, SEO, and Google Business Profile before this model call. ` +
          `Use all available sources, identify the two or three highest-leverage priorities, and explain why each matters, who should own it, and how success will be measured. ` +
          `Do not say that pipeline, contacts, appointments, conversations, or other reporting data is unavailable unless this live result explicitly says so. ` +
          `Do not reveal internal location, integration, resource, OAuth, pipeline, or provider identifiers. ` +
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
        ...promptPriorMessages,
        ...promptHistory,
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
    if (preflight?.ok && this.isBusinessProfileQuestion(command.message)) {
      content = this.formatBusinessProfileAnswer(preflight.output as any);
    }
    if (preflight?.ok && preflightTool === 'get_cmo_business_summary' && this.requiresCmoBusinessGrounding(command.message)) {
      content = this.formatCmoPriorityAnswer(preflight.output as any);
    }
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
    // Keep profile answers deterministic even if the generic response reviewer
    // tries to rewrite the model draft with stale permission language.
    if (preflight?.ok && this.isBusinessProfileQuestion(command.message)) {
      content = this.formatBusinessProfileAnswer(preflight.output as any);
      revised = false;
    }
    if (preflight?.ok && preflightTool === 'get_cmo_business_summary' && this.requiresCmoBusinessGrounding(command.message)) {
      content = this.formatCmoPriorityAnswer(preflight.output as any);
      revised = false;
    }
    if (sessionId && !command.ephemeral) {
      await this.persistTranscript(
        command.organizationId,
        sessionId,
        result.messages,
        2 + promptPriorMessages.length + promptHistory.length,
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
    return /\b(?:gbp|google\s+business(?:\s+profile)?|business\s+profile|google\s+reviews?|reviews?|ratings?|reputation|local\s+profile)\b/i.test(
      message,
    );
  }

  private isBusinessProfileQuestion(message: string): boolean {
    return /business\s+profile|google\s+business\s+profile|\bgbp\b/i.test(message);
  }

  private requiresCmoBusinessGrounding(message: string): boolean {
    return /(?:what|where)\s+should\s+we\s+focus|priorit(?:y|ies|ize)|this\s+week|weekly|overall\s+(?:performance|growth|business)|business\s+(?:overview|performance|health)|growth\s+(?:review|plan|opportunities)/i.test(message);
  }

  private formatCmoPriorityAnswer(summary: any): string {
    const source = (name: string, value: any) => {
      if (!value || value.available === false || value.connected === false)
        return `${name}: unavailable${value?.message ? ` (${value.message})` : ''}`;
      return `${name}: available`;
    };
    const ga = summary.websiteAnalytics;
    const gsc = summary.searchConsole;
    const pipeline = summary.goHighLevelPipeline;
    const ops = summary.goHighLevelOperations;
    const seo = summary.seo;
    const gbp = summary.googleBusinessProfile;
    const sessions = ga?.metrics?.sessions ?? 0;
    const users = ga?.metrics?.activeUsers ?? 0;
    const conversions = ga?.metrics?.conversions ?? 0;
    const pipelineValue = Number(pipeline?.pipelineValue ?? 0);
    const openOps = pipeline?.byStatus?.open ?? pipeline?.byStatus?.Open ?? 0;
    const audit = seo?.technicalAudit;
    const priorities = [
      conversions === 0 ? `**1. Set up and test conversion tracking**\nYour site recorded ${sessions} sessions from ${users} active users but no conversions. Confirm that contact forms, calls, and appointment bookings create measurable conversion events.` : null,
      pipelineValue > 0 && Number(openOps) > 0 ? `**2. Move the active pipeline forward**\nGoHighLevel shows approximately $${pipelineValue.toLocaleString()} in pipeline value and ${openOps} open opportunities. Assign a next step and due date to every open opportunity.` : null,
      audit?.issueCount > 0 ? `**3. Resolve the highest-impact website findings**\nThe latest technical audit reports ${audit.issueCount} issue(s). Start with the high-priority findings and verify the fixes after the next crawl.` : null,
      gbp?.accessStatus === 'permission_required' ? '**4. Improve local visibility**\nThe public business listing is available, but review monitoring is limited by the current GoHighLevel app permissions. Review the app approval when convenient; this is an administrative item, not a client reconnection.' : null,
    ].filter((item): item is string => Boolean(item));
    if (!priorities.length)
      priorities.push('**1. Continue monitoring**\nNo urgent cross-channel issue is supported by the latest connected data. Review the dashboard again after the next synchronization.');
    const checked = [
      source('Website analytics', ga), source('Search Console', gsc),
      source('GoHighLevel pipeline', pipeline), source('GoHighLevel operations', ops),
      source('SEO audit', seo), source('Google Business Profile', gbp),
    ].map((line) => `- ${line}`).join('\n');
    return `## This week's priorities\n\n${priorities.join('\n\n')}\n\n### Connected data checked\n${checked}\n\nThese recommendations are based on the latest synchronized data.`;
  }

  private formatBusinessProfileAnswer(summary: any): string {
    const profile = summary?.businessProfile;
    if (!profile?.available) {
      return `## Google Business Profile\n\nPublic listing details are not available yet. ${profile?.message ?? 'The listing could not be returned by Google.'}\n\nReview data and Maps performance are separate sources and may require additional administrator configuration.`;
    }
    const value = (v: unknown) => v === null || v === undefined || v === '' ? 'Not provided' : String(v);
    const categories = Array.isArray(profile.categories) && profile.categories.length ? profile.categories.join(', ') : 'Not provided';
    const hours = Array.isArray(profile.openingHours) && profile.openingHours.length ? profile.openingHours.join('; ') : 'Not provided';
    const socialEntries = summary?.supplementalSocialProfiles
      ? Object.entries(summary.supplementalSocialProfiles).filter(([k, v]) =>
          !/place.?id|location.?id|integration.?id|resource.?id|oauth|token/i.test(k) && Boolean(v),
        )
      : [];
    const social = socialEntries.length
      ? socialEntries.map(([k, v]) => `- ${k}: ${v}`).join('\n')
      : 'No social profiles are stored in GoHighLevel.';
    const reviewNote = summary?.accessStatus === 'permission_required'
      ? '\n\nReview access is currently limited by the GoHighLevel app permissions. This does not affect the public listing details above.'
      : '';
    return `## Google Business Profile\n\n### Business details\n\n| Field | Details |\n| --- | --- |\n| Business name | ${value(profile.name)} |\n| Primary category | ${value(profile.primaryCategory)} |\n| Additional categories | ${categories} |\n| Description | ${value(profile.description)} |\n| Address | ${value(profile.address)} |\n| Phone | ${value(profile.phone)} |\n| Website | ${value(profile.website)} |\n| Google Maps | ${value(profile.mapsUrl)} |\n| Business status | ${value(profile.businessStatus)} |\n| Open now | ${profile.openNow === null ? 'Not provided' : profile.openNow ? 'Open' : 'Closed'} |\n\n### Hours\n${hours}\n\n### Public profile signals\n- Google rating: ${profile.rating ? `${profile.rating}/5` : 'Not provided'}\n- Google review count: ${profile.reviewCount || 0}\n- Public photos: ${profile.photoCount || 0}\n- Public review samples: ${profile.publicReviewSampleCount || 0}\n\n### GoHighLevel social profiles\n${social}${reviewNote}\n\nMaps impressions, calls, website clicks, and direction requests are not returned by the available profile data source.`;
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
