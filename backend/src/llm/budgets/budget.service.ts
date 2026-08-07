import { Injectable, Logger } from '@nestjs/common';
import type { Transaction } from 'kysely';
import { DatabaseService, type BudgetPeriod, type Database } from '../../shared/database';
import { EventType, OutboxService } from '../../shared/events';
import { AppException, ErrorCode } from '../../shared/http';

export interface BudgetStatus {
  readonly hasBudget: boolean;
  readonly period: BudgetPeriod;
  readonly periodStart: Date;
  readonly spendMicroUsd: number;
  readonly limitMicroUsd: number;
  readonly utilization: number;
  readonly softThresholdCrossed: boolean;
  readonly hardLimitReached: boolean;
  readonly enforced: boolean;
}

/**
 * Organization AI budgets.
 *
 * Two thresholds, deliberately distinct:
 *
 *   - **Soft threshold** (default 80%) emits `AiBudgetThresholdReached` once per
 *     period so someone can act before service is interrupted.
 *   - **Hard limit** (100%) refuses further calls when `enforce_hard_limit` is
 *     set — checked BEFORE the model is invoked, because a check afterwards
 *     cannot prevent the spend it was meant to cap.
 *
 * Alerts are deduplicated by a UNIQUE constraint on
 * (budget_id, kind, period_start). Without it, every call past 80% would emit
 * another event — an alert storm that trains people to ignore alerts.
 *
 * An organization with no budget row is unlimited. That is the intended default:
 * a missing configuration row must not silently disable a customer's product.
 */
@Injectable()
export class BudgetService {
  private readonly logger = new Logger(BudgetService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Refuses the call if the organization is over its enforced hard limit.
   *
   * Called before every model invocation. Throws `AI_BUDGET_EXCEEDED` (429).
   */
  async assertWithinBudget(organizationId: string): Promise<void> {
    const statuses = await this.statuses(organizationId);
    const exceeded = statuses.find((status) => status.hardLimitReached && status.enforced);

    if (exceeded) {
      throw new AppException(
        ErrorCode.AI_BUDGET_EXCEEDED,
        'This organization has reached its AI spending limit for the current period.',
        429,
        {
          period: exceeded.period,
          spendMicroUsd: exceeded.spendMicroUsd,
          limitMicroUsd: exceeded.limitMicroUsd,
        },
      );
    }
  }

  async status(organizationId: string): Promise<BudgetStatus> {
    const statuses = await this.statuses(organizationId);
    return statuses.sort((a, b) => b.utilization - a.utilization)[0] ?? this.unlimitedStatus();
  }

  async statuses(organizationId: string): Promise<BudgetStatus[]> {
    const budgets = await this.database.transaction(async (trx) =>
      trx
        .selectFrom('capere.ai_budgets')
        .select(['id', 'period', 'limit_micro_usd', 'soft_threshold', 'enforce_hard_limit'])
        .where('organization_id', '=', organizationId)
        .forUpdate()
        .execute(),
    );

    if (budgets.length === 0) return [];

    return Promise.all(
      budgets.map(async (budget) => {
        const periodStart = startOfPeriod(budget.period);
        const spend = await this.spendSince(organizationId, periodStart);
        const limit = Number(budget.limit_micro_usd);
        const softThreshold = Number(budget.soft_threshold);
        const utilization = limit > 0 ? spend / limit : 0;

        return {
          hasBudget: true,
          period: budget.period,
          periodStart,
          spendMicroUsd: spend,
          limitMicroUsd: limit,
          utilization,
          softThresholdCrossed: utilization >= softThreshold,
          hardLimitReached: spend >= limit,
          enforced: budget.enforce_hard_limit,
        };
      }),
    );
  }

  private unlimitedStatus(): BudgetStatus {
    return {
      hasBudget: false,
      period: 'monthly',
      periodStart: startOfPeriod('monthly'),
      spendMicroUsd: 0,
      limitMicroUsd: 0,
      utilization: 0,
      softThresholdCrossed: false,
      hardLimitReached: false,
      enforced: false,
    };
  }

  /**
   * Re-evaluates thresholds after a call and emits an alert if one was crossed.
   *
   * Runs AFTER usage is recorded, since it reads the updated ledger. Publishing
   * through the outbox in the same transaction as the alert row keeps the event
   * and the dedupe record atomic — an alert row without its event, or vice
   * versa, would either double-notify or never notify.
   */
  async evaluateAfterUsage(organizationId: string): Promise<void> {
    const statuses = await this.statuses(organizationId);
    if (statuses.length === 0) return;

    for (const status of statuses) {
      const kind = status.hardLimitReached
        ? ('hard_limit' as const)
        : status.softThresholdCrossed
          ? ('soft_threshold' as const)
          : undefined;
      if (!kind) continue;

      const budget = await this.database.db
        .selectFrom('capere.ai_budgets')
        .select('id')
        .where('organization_id', '=', organizationId)
        .where('period', '=', status.period)
        .executeTakeFirst();
      if (!budget) continue;

      await this.database.transaction(async (trx) => {
        const inserted = await this.recordAlert(trx, {
          organizationId,
          budgetId: budget.id,
          kind,
          periodStart: status.periodStart,
          spendMicroUsd: status.spendMicroUsd,
          limitMicroUsd: status.limitMicroUsd,
        });

        if (!inserted) return;

        await this.outbox.publishInTransaction(trx, {
          type: EventType.AiBudgetThresholdReached,
          organizationId,
          aggregateType: 'ai_budget',
          aggregateId: budget.id,
          payload: {
            budgetId: budget.id,
            kind,
            period: status.period,
            spendMicroUsd: String(status.spendMicroUsd),
            limitMicroUsd: String(status.limitMicroUsd),
            utilization: Number(status.utilization.toFixed(4)),
          },
        });

        this.logger.warn(
          `Organization ${organizationId} crossed ${kind} ` +
            `(${status.spendMicroUsd}/${status.limitMicroUsd} micro-USD, ${status.period})`,
        );
      });
    }
  }

  async setBudget(params: {
    organizationId: string;
    period: BudgetPeriod;
    limitMicroUsd: number;
    softThreshold?: number;
    enforceHardLimit?: boolean;
  }): Promise<void> {
    await this.database.db
      .insertInto('capere.ai_budgets')
      .values({
        organization_id: params.organizationId,
        period: params.period,
        limit_micro_usd: String(params.limitMicroUsd),
        soft_threshold: String(params.softThreshold ?? 0.8),
        enforce_hard_limit: params.enforceHardLimit ?? true,
      })
      .onConflict((oc) =>
        oc.columns(['organization_id', 'period']).doUpdateSet({
          limit_micro_usd: String(params.limitMicroUsd),
          soft_threshold: String(params.softThreshold ?? 0.8),
          enforce_hard_limit: params.enforceHardLimit ?? true,
          updated_at: new Date(),
        }),
      )
      .execute();
  }

  /** Total spend since `since`, in micro-USD. */
  private async spendSince(organizationId: string, since: Date): Promise<number> {
    const row = await this.database.db
      .selectFrom('capere.ai_usage_events')
      .select((eb) => eb.fn.coalesce(eb.fn.sum<string>('cost_micro_usd'), eb.val('0')).as('total'))
      .where('organization_id', '=', organizationId)
      .where('created_at', '>=', since)
      .executeTakeFirst();

    // SUM over bigint returns numeric, which pg hands back as a string.
    return Number(row?.total ?? 0);
  }

  /** Inserts an alert, returning false if one already exists for this period. */
  private async recordAlert(
    trx: Transaction<Database>,
    params: {
      organizationId: string;
      budgetId: string;
      kind: 'soft_threshold' | 'hard_limit';
      periodStart: Date;
      spendMicroUsd: number;
      limitMicroUsd: number;
    },
  ): Promise<boolean> {
    const result = await trx
      .insertInto('capere.ai_budget_alerts')
      .values({
        organization_id: params.organizationId,
        budget_id: params.budgetId,
        kind: params.kind,
        period_start: params.periodStart,
        spend_micro_usd: String(params.spendMicroUsd),
        limit_micro_usd: String(params.limitMicroUsd),
      })
      .onConflict((oc) => oc.columns(['budget_id', 'kind', 'period_start']).doNothing())
      .returning('id')
      .executeTakeFirst();

    return result !== undefined;
  }
}

/**
 * Start of the current budget period, in UTC.
 *
 * UTC deliberately: an organization-local period boundary would make spend
 * comparisons across tenants incoherent and make the dedupe key ambiguous
 * around DST transitions.
 */
export function startOfPeriod(period: BudgetPeriod, now = new Date()): Date {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );

  if (period === 'daily') return start;

  if (period === 'weekly') {
    // ISO weeks start Monday; getUTCDay() returns 0 for Sunday.
    const dayOfWeek = start.getUTCDay();
    const daysSinceMonday = (dayOfWeek + 6) % 7;
    start.setUTCDate(start.getUTCDate() - daysSinceMonday);
    return start;
  }

  start.setUTCDate(1);
  return start;
}
