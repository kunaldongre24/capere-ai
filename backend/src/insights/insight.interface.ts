import type { DomainEvent, EventTypeValue } from '../shared/events';

/**
 * The Insights Engine.
 *
 * WHY IT SITS BETWEEN ANALYTICS AND THE CMO AGENT: without it, every consumer
 * that wants to know "GA4 traffic dropped 30% month over month" reimplements
 * that calculation — the dashboard, the weekly report, the recommendation
 * engine, and the CMO agent each with their own slightly different threshold.
 * They then disagree, and nobody can say which is right.
 *
 * An insight is computed ONCE, stored, and consumed by all of them. That makes
 * it the single source of truth for "what is notable about this account right
 * now."
 *
 * PHASE 1 SCOPE: the domain model, ports, storage, event-triggered execution,
 * and ONE real generator. The generators that matter commercially depend on
 * GA4/GSC/GBP data, which arrives in Phase 3 — writing them now would encode
 * guesses about schemas that do not exist yet.
 */

export type InsightCategory = 'analytics' | 'seo' | 'gbp' | 'revenue' | 'operations' | 'marketing';

export type InsightSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

/** An insight a generator wishes to record. */
export interface InsightDraft {
  readonly category: InsightCategory;
  readonly severity: InsightSeverity;
  readonly title: string;
  readonly body: string;
  /**
   * Stable key identifying the SIGNAL, not the occurrence.
   *
   * Two runs detecting the same condition must produce the same key, or every
   * scheduled sweep would pile up duplicates of the same finding. Example:
   * `integration_disconnected:google_analytics_4`.
   */
  readonly dedupeKey: string;
  /** Structured facts for dashboards and downstream recommendation logic. */
  readonly payload?: Record<string, unknown>;
  readonly confidence?: number;
  readonly expiresAt?: Date;
}

/**
 * A generator turns organization state, or a domain event, into insights.
 *
 * Generators are pure analysis: they read, they never write. The engine owns
 * persistence, deduplication and event publication, so a generator cannot
 * accidentally skip any of it.
 */
export interface InsightGenerator {
  /** Stable slug, recorded as `source_generator` on every insight produced. */
  readonly name: string;

  /** Human-readable purpose, for the generator catalog endpoint. */
  readonly description: string;

  /**
   * Event types that trigger this generator. Empty means it only runs on a
   * schedule or when invoked explicitly.
   */
  readonly triggers: readonly EventTypeValue[];

  /**
   * Produces insights for an organization.
   *
   * @param event The triggering event, when run reactively; undefined on a
   *              scheduled sweep.
   */
  generate(organizationId: string, event?: DomainEvent): Promise<InsightDraft[]>;
}

/** DI token; generators register themselves against it. */
export const INSIGHT_GENERATORS = Symbol('INSIGHT_GENERATORS');
