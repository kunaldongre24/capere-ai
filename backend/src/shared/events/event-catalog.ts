/**
 * Domain event catalog.
 *
 * Every event the system can publish is declared here with a typed payload, so
 * publishers and subscribers share one compile-time contract instead of passing
 * untyped blobs and hoping.
 *
 * PHASE 1 SCOPE — an honest note: only the events whose publishers exist today
 * can actually fire. `GA4Synced`, `SeoAuditCompleted` and `LeadCaptured` are
 * declared now because settling payload shapes early is cheap and changing them
 * later is not, but nothing publishes them until their Phase 3 integrations
 * land. They are marked below.
 *
 * Naming: `<aggregate>.<past-tense-verb>`. Events describe what HAPPENED, never
 * what should happen next — a subscriber decides that.
 */

export const EventType = {
  // --- Integrations (publishers exist in Phase 1) ---
  IntegrationConnected: 'integration.connected',
  IntegrationDisconnected: 'integration.disconnected',
  IntegrationErrored: 'integration.errored',

  // --- Insights (publisher exists in Phase 1) ---
  InsightGenerated: 'insight.generated',

  // --- AI cost control (publisher exists in Phase 1) ---
  AiBudgetThresholdReached: 'ai_budget.threshold_reached',

  // --- Recommendations (Phase 5 publisher) ---
  RecommendationGenerated: 'recommendation.generated',

  // --- Analytics / SEO (Phase 3 publishers) ---
  Ga4Synced: 'ga4.synced',
  GscSynced: 'gsc.synced',
  GbpSynced: 'gbp.synced',
  SeoAuditCompleted: 'seo_audit.completed',
  LeadCaptured: 'lead.captured',
  OpportunityCreated: 'opportunity.created',
  OpportunityUpdated: 'opportunity.updated',
  OpportunityStageUpdated: 'opportunity.stage_updated',
  OpportunityStatusUpdated: 'opportunity.status_updated',
  AppointmentCreated: 'appointment.created',
  AppointmentUpdated: 'appointment.updated',
} as const;

export type EventTypeValue = (typeof EventType)[keyof typeof EventType];

// --- Payloads -------------------------------------------------------------

export interface IntegrationConnectedPayload {
  integrationId: string;
  provider: string;
  accountName?: string;
  ghlLocationId?: string;
}

export interface IntegrationDisconnectedPayload {
  integrationId: string;
  provider: string;
  reason: 'user_revoked' | 'token_expired' | 'provider_error' | 'admin_action';
}

export interface IntegrationErroredPayload {
  integrationId: string;
  provider: string;
  errorCode: string;
  message: string;
}

export interface InsightGeneratedPayload {
  insightId: string;
  category: string;
  severity: string;
  generator: string;
  title: string;
}

export interface AiBudgetThresholdReachedPayload {
  budgetId: string;
  kind: 'soft_threshold' | 'hard_limit';
  period: string;
  spendMicroUsd: string;
  limitMicroUsd: string;
  /** Fraction of the limit consumed, e.g. 0.82. */
  utilization: number;
}

export interface RecommendationGeneratedPayload {
  recommendationId: string;
  category: string;
  priority: string;
}

/** Phase 3. Declared now so the payload shape is settled. */
export interface Ga4SyncedPayload {
  integrationId: string;
  propertyId: string;
  periodStart: string;
  periodEnd: string;
  sessions: number;
  conversions: number;
}

/** Phase 3. */
export interface GscSyncedPayload {
  integrationId: string;
  siteUrl: string;
  periodStart: string;
  periodEnd: string;
  clicks: number;
  impressions: number;
}

/** Phase 3. */
export interface GbpSyncedPayload {
  integrationId: string;
  locationId: string;
  reviewCount: number;
  averageRating: number;
}

/** Phase 3. */
export interface SeoAuditCompletedPayload {
  auditId: string;
  siteUrl: string;
  score: number;
  issueCount: number;
}

/** Phase 3 — published from a GoHighLevel webhook. */
export interface LeadCapturedPayload {
  ghlContactId: string;
  ghlLocationId: string;
  source?: string;
}

export interface OpportunityCreatedPayload {
  ghlOpportunityId: string;
  ghlLocationId: string;
  ghlContactId?: string;
  monetaryValue?: number;
  pipelineId?: string;
  pipelineStageId?: string;
  status?: string;
}

export type OpportunityUpdatedPayload = OpportunityCreatedPayload;
export type OpportunityStageUpdatedPayload = OpportunityCreatedPayload;
export type OpportunityStatusUpdatedPayload = OpportunityCreatedPayload;

export interface AppointmentEventPayload {
  ghlAppointmentId: string;
  ghlLocationId: string;
  ghlContactId?: string;
  ghlCalendarId?: string;
  assignedUserId?: string;
  appointmentStatus?: string;
  startTime?: string;
  endTime?: string;
}

export type AppointmentCreatedPayload = AppointmentEventPayload;
export type AppointmentUpdatedPayload = AppointmentEventPayload;

/**
 * Maps each event type to its payload. Publishing or subscribing with a
 * mismatched payload is a compile error, not a runtime surprise.
 */
export interface EventPayloadMap {
  [EventType.IntegrationConnected]: IntegrationConnectedPayload;
  [EventType.IntegrationDisconnected]: IntegrationDisconnectedPayload;
  [EventType.IntegrationErrored]: IntegrationErroredPayload;
  [EventType.InsightGenerated]: InsightGeneratedPayload;
  [EventType.AiBudgetThresholdReached]: AiBudgetThresholdReachedPayload;
  [EventType.RecommendationGenerated]: RecommendationGeneratedPayload;
  [EventType.Ga4Synced]: Ga4SyncedPayload;
  [EventType.GscSynced]: GscSyncedPayload;
  [EventType.GbpSynced]: GbpSyncedPayload;
  [EventType.SeoAuditCompleted]: SeoAuditCompletedPayload;
  [EventType.LeadCaptured]: LeadCapturedPayload;
  [EventType.OpportunityCreated]: OpportunityCreatedPayload;
  [EventType.OpportunityUpdated]: OpportunityUpdatedPayload;
  [EventType.OpportunityStageUpdated]: OpportunityStageUpdatedPayload;
  [EventType.OpportunityStatusUpdated]: OpportunityStatusUpdatedPayload;
  [EventType.AppointmentCreated]: AppointmentCreatedPayload;
  [EventType.AppointmentUpdated]: AppointmentUpdatedPayload;
}

/** An event as it travels through the bus. */
export interface DomainEvent<T extends EventTypeValue = EventTypeValue> {
  readonly id: string;
  readonly type: T;
  readonly organizationId: string;
  readonly payload: EventPayloadMap[T];
  readonly payloadVersion: number;
  readonly aggregateType?: string;
  readonly aggregateId?: string;
  readonly occurredAt: Date;
}

export interface ClaimedDomainEvent<
  T extends EventTypeValue = EventTypeValue,
> extends DomainEvent<T> {
  readonly claimToken: string;
}

/** Everything needed to publish, minus what the outbox assigns. */
export interface EventToPublish<T extends EventTypeValue = EventTypeValue> {
  readonly type: T;
  readonly organizationId: string;
  readonly payload: EventPayloadMap[T];
  readonly aggregateType?: string;
  readonly aggregateId?: string;
  readonly payloadVersion?: number;
}
