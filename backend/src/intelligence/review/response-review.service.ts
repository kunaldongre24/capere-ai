import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import type { AgentKind } from '../../shared/database';
import { ModelRouterService } from '../../llm';
import type { ToolResult } from '../tools/tool.interface';

export interface ReflectionVerdict {
  readonly approved: boolean;
  readonly issues: Array<{ kind: string; detail: string }>;
  /** Present when the reflector rewrote the answer. */
  readonly revisedResponse?: string;
}

const verdictSchema = z
  .object({
    approved: z.boolean(),
    issues: z.array(z.object({ kind: z.string().min(1), detail: z.string() })),
    revisedResponse: z.string().min(1).optional().nullable(),
  })
  .refine((verdict) => verdict.approved || Boolean(verdict.revisedResponse), {
    message: 'Rejected responses must include a revisedResponse',
  });

const SAFE_REFLECTION_FAILURE =
  'I could not safely verify this response, so I am not presenting the unreviewed result. Please try again.';

/**
 * The reflection pass: critiques a draft answer before the user sees it.
 *
 * WHY THIS EXISTS AT ALL — the specific risk in this product. Capere advises
 * CPA firms on business decisions. A fabricated ranking, invented competitor,
 * or made-up traffic number in an executive report is not an embarrassing
 * quirk; it is advice someone may act on. Reflection is the last gate before
 * that reaches a client.
 *
 * DESIGN CHOICES:
 *
 * - **Cheap model.** Critique is easier than generation, so reflection routes
 *   to the 'cheap' chain. Paying frontier prices to double-check every answer
 *   would roughly double cost for a fraction of the value.
 *
 * - **Fails closed.** If reflection errors or returns malformed output, the
 *   unreviewed draft is withheld and replaced with a safe retry message.
 *
 * - **Grounding is computed, not asked.** The prompt is told exactly which
 *   tools succeeded and which failed, so "you cited GA4 data but GA4 is not
 *   connected" is checkable rather than a matter of the critic's opinion.
 */
@Injectable()
export class ResponseReviewService {
  private readonly logger = new Logger(ResponseReviewService.name);

  constructor(private readonly modelRouter: ModelRouterService) {}

  async review(params: {
    organizationId: string;
    userId?: string;
    sessionId?: string;
    agent: AgentKind;
    userRequest: string;
    draft: string;
    toolResults: ToolResult[];
    reflectionPrompt: string;
    promptName?: string;
    promptVersion?: number;
    promptChecksum?: string;
    signal?: AbortSignal;
  }): Promise<ReflectionVerdict> {
    // Nothing to critique — skip the call rather than spend a token on it.
    if (!params.draft.trim()) {
      return { approved: true, issues: [] };
    }

    const evidence = this.describeEvidence(params.toolResults);

    try {
      const completion = await this.modelRouter.complete(
        {
          messages: [
            { role: 'system', content: params.reflectionPrompt },
            {
              role: 'user',
              content:
                `USER REQUEST:\n${params.userRequest}\n\n` +
                `EVIDENCE AVAILABLE TO THE ASSISTANT:\n${evidence}\n\n` +
                `DRAFT RESPONSE:\n${params.draft}`,
            },
          ],
          responseFormat: { type: 'json_object' },
          signal: params.signal,
        },
        {
          organizationId: params.organizationId,
          userId: params.userId,
          sessionId: params.sessionId,
          agent: params.agent,
          // Critique is cheaper than generation.
          taskType: 'cheap',
          promptName: params.promptName,
          promptVersion: params.promptVersion,
          promptChecksum: params.promptChecksum,
          metadata: { stage: 'reflection' },
        },
      );

      return this.parse(completion.content);
    } catch (error) {
      this.logger.error(
        `Reflection failed closed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        approved: false,
        issues: [{ kind: 'reflection_unavailable', detail: 'The response could not be verified.' }],
        revisedResponse: SAFE_REFLECTION_FAILURE,
      };
    }
  }

  /**
   * Summarizes what the assistant actually had to work with.
   *
   * Failed tools are listed explicitly, because the most valuable thing
   * reflection can catch is an answer that cites data the assistant never
   * successfully retrieved.
   */
  private describeEvidence(results: ToolResult[]): string {
    if (results.length === 0) {
      return 'No tools were called. Any specific metric, ranking, or figure in the draft is unsupported.';
    }

    const lines = results.map((result) => {
      if (!result.ok) {
        return `- ${result.toolName}: FAILED (${result.error?.code}). No data from this source.`;
      }
      const rendered =
        typeof result.output === 'string' ? result.output : JSON.stringify(result.output ?? null);
      // Truncated: the critic needs to know what was returned, not re-read a
      // large payload in full.
      return `- ${result.toolName}: ${rendered.slice(0, 500)}`;
    });

    return lines.join('\n');
  }

  private parse(content: string): ReflectionVerdict {
    const cleaned = content
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    const parsed = verdictSchema.parse(JSON.parse(cleaned));

    return {
      approved: parsed.approved,
      issues: parsed.issues,
      revisedResponse: parsed.revisedResponse ?? undefined,
    };
  }
}
