import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService, type AgentKind } from '../../shared/database';
import type { LlmUsage } from '../llm-provider.port';

export interface RecordUsageParams {
  organizationId: string;
  sessionId?: string;
  userId?: string;
  agent?: AgentKind;
  requestedModel: string;
  servedModel: string;
  provider: string;
  taskType?: string;
  /** Prompt provenance, so an output can be traced to the exact revision. */
  promptName?: string;
  promptVersion?: number;
  promptChecksum?: string;
  usage: LlmUsage;
  latencyMs?: number;
  /** 0 = primary model; >0 means a fallback served the request. */
  fallbackIndex?: number;
  succeeded?: boolean;
  errorCode?: string;
  metadata?: Record<string, unknown>;
}

/**
 * The AI usage ledger.
 *
 * Append-only by policy: corrections are new rows, never updates, so spend
 * history stays auditable. RLS grants members SELECT but no write — only the
 * service role writes here, which keeps the record tamper-evident.
 *
 * FAILED CALLS ARE RECORDED TOO. A timed-out or rate-limited request may still
 * have consumed upstream tokens, and a ledger that only counted successes would
 * under-report spend — exactly the direction of error that silently blows a
 * budget.
 */
@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(private readonly database: DatabaseService) {}

  async record(params: RecordUsageParams): Promise<string> {
    // A silent failure here means unbilled spend and a budget that can never
    // trip, so it is logged at error level before being rethrown.
    try {
      return await this.insert(params);
    } catch (error) {
      this.logger.error(
        `Failed to record AI usage for organization ${params.organizationId} ` +
          `(model ${params.servedModel}, ${params.usage.totalTokens} tokens, ` +
          `${params.usage.costMicroUsd} micro-USD): ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  private async insert(params: RecordUsageParams): Promise<string> {
    const row = await this.database.db
      .insertInto('capere.ai_usage_events')
      .values({
        organization_id: params.organizationId,
        session_id: params.sessionId ?? null,
        user_id: params.userId ?? null,
        agent: params.agent ?? 'general',
        requested_model: params.requestedModel,
        served_model: params.servedModel,
        provider: params.provider,
        task_type: params.taskType ?? 'general',
        prompt_name: params.promptName ?? null,
        prompt_version: params.promptVersion ?? null,
        prompt_checksum: params.promptChecksum ?? null,
        prompt_tokens: params.usage.promptTokens,
        completion_tokens: params.usage.completionTokens,
        total_tokens: params.usage.totalTokens,
        cost_micro_usd: String(params.usage.costMicroUsd),
        latency_ms: params.latencyMs ?? null,
        fallback_index: params.fallbackIndex ?? 0,
        succeeded: params.succeeded ?? true,
        error_code: params.errorCode ?? null,
        metadata: JSON.stringify(params.metadata ?? {}),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    return row.id;
  }

  /** Aggregate spend for a window — powers dashboards and margin analysis. */
  async summarize(
    organizationId: string,
    since: Date,
  ): Promise<{
    totalCostMicroUsd: number;
    totalTokens: number;
    callCount: number;
    failureCount: number;
    byModel: Array<{ model: string; costMicroUsd: number; tokens: number; calls: number }>;
  }> {
    const totals = await this.database.db
      .selectFrom('capere.ai_usage_events')
      .select((eb) => [
        eb.fn.coalesce(eb.fn.sum<string>('cost_micro_usd'), eb.val('0')).as('cost'),
        eb.fn.coalesce(eb.fn.sum<string>('total_tokens'), eb.val('0')).as('tokens'),
        eb.fn.countAll<string>().as('calls'),
      ])
      .where('organization_id', '=', organizationId)
      .where('created_at', '>=', since)
      .executeTakeFirstOrThrow();

    const failures = await this.database.db
      .selectFrom('capere.ai_usage_events')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('organization_id', '=', organizationId)
      .where('created_at', '>=', since)
      .where('succeeded', '=', false)
      .executeTakeFirstOrThrow();

    const byModel = await this.database.db
      .selectFrom('capere.ai_usage_events')
      .select((eb) => [
        'served_model',
        eb.fn.coalesce(eb.fn.sum<string>('cost_micro_usd'), eb.val('0')).as('cost'),
        eb.fn.coalesce(eb.fn.sum<string>('total_tokens'), eb.val('0')).as('tokens'),
        eb.fn.countAll<string>().as('calls'),
      ])
      .where('organization_id', '=', organizationId)
      .where('created_at', '>=', since)
      .groupBy('served_model')
      .orderBy('cost', 'desc')
      .execute();

    return {
      totalCostMicroUsd: Number(totals.cost),
      totalTokens: Number(totals.tokens),
      callCount: Number(totals.calls),
      failureCount: Number(failures.n),
      byModel: byModel.map((r) => ({
        model: r.served_model,
        costMicroUsd: Number(r.cost),
        tokens: Number(r.tokens),
        calls: Number(r.calls),
      })),
    };
  }
}
