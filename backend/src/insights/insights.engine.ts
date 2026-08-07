import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DatabaseService } from '../shared/database';
import { EventType, OutboxService, type DomainEvent, type EventTypeValue } from '../shared/events';
import { FeatureFlag, FeatureFlagService } from '../feature-flags';
import { INSIGHT_GENERATORS, type InsightDraft, type InsightGenerator } from './insight.interface';

/**
 * Runs generators and persists what they produce.
 *
 * The engine — not any individual generator — owns:
 *
 *   - **Deduplication.** `UNIQUE (organization_id, dedupe_key)` plus an upsert
 *     means a condition detected on every hourly sweep updates one row instead
 *     of accumulating 24 identical insights a day.
 *
 *   - **Event publication.** `InsightGenerated` is written to the outbox in the
 *     SAME transaction as the insight row, so a subscriber can never be woken
 *     for an insight that was rolled back.
 *
 *   - **Isolation between generators.** One throwing must not prevent the
 *     others from running; a broken SEO generator should not silence analytics.
 */
@Injectable()
export class InsightsEngine {
  private readonly logger = new Logger(InsightsEngine.name);
  private readonly generators: InsightGenerator[];

  constructor(
    private readonly database: DatabaseService,
    private readonly outbox: OutboxService,
    private readonly flags: FeatureFlagService,
    @Optional()
    @Inject(INSIGHT_GENERATORS)
    generators?: InsightGenerator[],
  ) {
    this.generators = generators ?? [];
  }

  /** Registered generator names — for the catalog endpoint and diagnostics. */
  registered(): string[] {
    return this.generators.map((g) => g.name);
  }

  /**
   * Runs every generator triggered by an event.
   *
   * Called by the outbox relay's subscriber. Generators run concurrently and
   * independently.
   */
  async runForEvent(event: DomainEvent): Promise<number> {
    const triggered = this.generators.filter((g) => g.triggers.includes(event.type));
    if (triggered.length === 0) return 0;

    return this.run(event.organizationId, triggered, event);
  }

  /** Runs every generator for an organization — the scheduled sweep. */
  async runAll(organizationId: string): Promise<number> {
    return this.run(organizationId, this.generators);
  }

  private async run(
    organizationId: string,
    generators: InsightGenerator[],
    event?: DomainEvent,
  ): Promise<number> {
    const enabled = await this.flags.isEnabled(organizationId, FeatureFlag.InsightsEngine);
    if (!enabled) {
      this.logger.debug(`Insights engine disabled for organization ${organizationId}`);
      return 0;
    }

    const batches = await Promise.all(
      generators.map(async (generator) => {
        try {
          const drafts = await generator.generate(organizationId, event);
          return { generator, drafts };
        } catch (error) {
          // One broken generator must not silence the others.
          this.logger.error(
            `Insight generator "${generator.name}" failed for organization ` +
              `${organizationId}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return { generator, drafts: [] as InsightDraft[] };
        }
      }),
    );

    let persisted = 0;
    for (const { generator, drafts } of batches) {
      for (const draft of drafts) {
        const created = await this.persist(organizationId, generator.name, draft, event?.id);
        if (created) persisted += 1;
      }
    }

    return persisted;
  }

  /**
   * Upserts an insight, publishing `InsightGenerated` only when it is NEW.
   *
   * Re-detecting an existing condition refreshes the row but does not re-emit —
   * otherwise every sweep would re-notify about a problem the user already
   * knows about.
   *
   * @returns true when a new insight was created.
   */
  private async persist(
    organizationId: string,
    generatorName: string,
    draft: InsightDraft,
    sourceEventId?: string,
  ): Promise<boolean> {
    return this.database.transaction(async (trx) => {
      const existing = await trx
        .selectFrom('capere.insights')
        .select('id')
        .where('organization_id', '=', organizationId)
        .where('dedupe_key', '=', draft.dedupeKey)
        .executeTakeFirst();

      if (existing) {
        await trx
          .updateTable('capere.insights')
          .set({
            severity: draft.severity,
            title: draft.title,
            body: draft.body,
            payload: JSON.stringify(draft.payload ?? {}),
            confidence: draft.confidence !== undefined ? String(draft.confidence) : null,
            expires_at: draft.expiresAt ?? null,
            // Re-detected: it is active again even if previously expired.
            status: 'active',
            updated_at: new Date(),
          })
          .where('id', '=', existing.id)
          .execute();

        return false;
      }

      const row = await trx
        .insertInto('capere.insights')
        .values({
          organization_id: organizationId,
          category: draft.category,
          severity: draft.severity,
          source_generator: generatorName,
          source_event_id: sourceEventId ?? null,
          dedupe_key: draft.dedupeKey,
          title: draft.title,
          body: draft.body,
          payload: JSON.stringify(draft.payload ?? {}),
          confidence: draft.confidence !== undefined ? String(draft.confidence) : null,
          expires_at: draft.expiresAt ?? null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      // Same transaction as the insight row: a subscriber can never be woken
      // for something that was rolled back.
      await this.outbox.publishInTransaction(trx, {
        type: EventType.InsightGenerated,
        organizationId,
        aggregateType: 'insight',
        aggregateId: row.id,
        payload: {
          insightId: row.id,
          category: draft.category,
          severity: draft.severity,
          generator: generatorName,
          title: draft.title,
        },
      });

      return true;
    });
  }

  /** Active insights for an organization, most severe first. */
  async active(
    organizationId: string,
    limit = 20,
  ): Promise<
    Array<{
      id: string;
      category: string;
      severity: string;
      title: string;
      body: string;
      payload: unknown;
      createdAt: Date;
    }>
  > {
    const rows = await this.database.db
      .selectFrom('capere.insights')
      .select(['id', 'category', 'severity', 'title', 'body', 'payload', 'created_at'])
      .where('organization_id', '=', organizationId)
      .where('status', '=', 'active')
      .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', new Date())]))
      .orderBy('created_at', 'desc')
      .limit(limit)
      .execute();

    return rows.map((row) => ({
      id: row.id,
      category: row.category,
      severity: row.severity,
      title: row.title,
      body: row.body,
      payload: row.payload,
      createdAt: row.created_at,
    }));
  }

  /** Marks an insight dismissed so it stops appearing in intelligence context. */
  async dismiss(organizationId: string, insightId: string): Promise<void> {
    await this.database.db
      .updateTable('capere.insights')
      .set({ status: 'dismissed', updated_at: new Date() })
      .where('organization_id', '=', organizationId)
      .where('id', '=', insightId)
      .execute();
  }

  /** Event types any registered generator listens for. */
  triggerTypes(): EventTypeValue[] {
    return [...new Set(this.generators.flatMap((g) => [...g.triggers]))];
  }
}
