import type { Generated } from 'kysely';

/**
 * Database schema types.
 *
 * NOTE ON PROVENANCE: these are regenerated from the live database with
 * `pnpm db:types` (kysely-codegen). The database is the source of truth; this
 * file is a projection of it. It is hand-maintained only until the first
 * successful codegen run against a migrated database, after which CI fails on
 * any diff between generated output and what is committed.
 *
 * See ADR-0002 for why the database, not a TS schema file, is authoritative.
 */

/**
 * Timestamp columns.
 *
 * A plain `Date` alias, deliberately NOT a `ColumnType`. `Generated<T>` is
 * itself a `ColumnType`, and Kysely does not recursively unwrap nested
 * `ColumnType`s — so `Generated<ColumnType<Date, …>>` would select as a
 * `ColumnType` rather than a `Date` and break every read site.
 *
 * With `Timestamp = Date`, `Generated<Timestamp>` resolves to
 * `ColumnType<Date, Date | undefined, Date>`, which is exactly right: reads
 * give a `Date` (node-postgres parses `timestamptz` into one), and inserts
 * require a real `Date` rather than accepting a loosely-typed string.
 */
export type Timestamp = Date;

export type Json = unknown;

// --- Enums (mirror capere.* enum types) ------------------------------------
export type OrgRole =
  'owner' | 'office_manager' | 'marketing_manager' | 'seo_specialist' | 'capere_admin';

export type OrgStatus = 'active' | 'suspended' | 'cancelled';

export type IntegrationProvider =
  | 'go_high_level'
  | 'google_analytics_4'
  | 'google_search_console'
  | 'google_business_profile'
  | 'data_for_seo'
  | 'github';

export type IntegrationStatus = 'disconnected' | 'connecting' | 'connected' | 'error' | 'revoked';

export type IntegrationScope = 'read' | 'write' | 'read_write';

export type AiSessionStatus = 'active' | 'completed' | 'failed' | 'abandoned';

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export type AgentKind =
  | 'hermes'
  | 'general'
  | 'seo'
  | 'gbp'
  | 'analytics'
  | 'cmo'
  | 'content'
  | 'automation'
  | 'knowledge';

export type BudgetPeriod = 'daily' | 'weekly' | 'monthly';

export type BudgetAlertKind = 'soft_threshold' | 'hard_limit';

export type InsightCategory = 'analytics' | 'seo' | 'gbp' | 'revenue' | 'operations' | 'marketing';

export type InsightSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export type InsightStatus = 'active' | 'expired' | 'dismissed' | 'applied';

export type JobStatus = 'scheduled' | 'running' | 'succeeded' | 'failed' | 'dead_lettered';

export type RagVisibility = 'shared' | 'tenant';
export type RagDocumentStatus =
  'pending' | 'processing' | 'indexed' | 'failed' | 'deleting' | 'deleted';
export type RagVersionStatus = 'pending' | 'processing' | 'indexed' | 'failed' | 'superseded';
export type RagJobOperation = 'ingest' | 'reindex' | 'delete';
export type RagJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'dead_lettered';
export type SyncStatus = 'idle' | 'queued' | 'running' | 'succeeded' | 'failed';
export type ProviderTaskStatus = 'submitted' | 'polling' | 'succeeded' | 'failed';
export type ChangeRequestStatus =
  'draft' | 'approved' | 'executing' | 'pull_request_opened' | 'failed' | 'cancelled';
export type RecommendationPriority = 'low' | 'medium' | 'high' | 'critical';
export type RecommendationStatus =
  'proposed' | 'approved' | 'in_progress' | 'completed' | 'dismissed' | 'expired';
export type DashboardKind = 'executive' | 'seo' | 'gbp' | 'lead' | 'revenue' | 'content';
export type AutomationStatus =
  'draft' | 'approved' | 'executing' | 'succeeded' | 'failed' | 'cancelled';
export type AutomationKind = 'ghl_task_create' | 'ghl_workflow_trigger';
export type ArtifactKind = 'daily_brief' | 'content_draft';

// --- Tables ---------------------------------------------------------------

export interface OrganizationsTable {
  id: Generated<string>;
  name: string;
  slug: string;
  status: Generated<OrgStatus>;
  settings: Generated<Json>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface UsersTable {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  last_seen_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface OrganizationMembersTable {
  id: Generated<string>;
  organization_id: string;
  user_id: string;
  role: Generated<OrgRole>;
  invited_by: string | null;
  joined_at: Generated<Timestamp>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface GhlLocationsTable {
  id: Generated<string>;
  organization_id: string;
  ghl_location_id: string;
  name: string | null;
  timezone: string | null;
  is_primary: Generated<boolean>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface IntegrationsTable {
  id: Generated<string>;
  organization_id: string;
  ghl_location_id: string | null;
  provider: IntegrationProvider;
  account_id: string | null;
  account_name: string | null;
  status: Generated<IntegrationStatus>;
  encrypted_credentials: Buffer | null;
  key_version: Generated<number>;
  scopes: Generated<IntegrationScope>;
  token_type: string | null;
  expires_at: Timestamp | null;
  last_sync_at: Timestamp | null;
  last_error: string | null;
  provider_metadata: Generated<Json>;
  authorization_id: string | null;
  sync_enabled: Generated<boolean>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface IntegrationAuthorizationsTable {
  id: Generated<string>;
  organization_id: string;
  provider: string;
  external_account_id: string | null;
  external_account_name: string | null;
  encrypted_credentials: Buffer;
  key_version: number;
  scopes: string[];
  expires_at: Timestamp | null;
  metadata: Generated<Json>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}
export interface OauthStatesTable {
  id: Generated<string>;
  organization_id: string;
  provider: string;
  state_hash: string;
  encrypted_code_verifier: Buffer;
  redirect_uri: string;
  requested_scopes: string[];
  expires_at: Timestamp;
  consumed_at: Timestamp | null;
  created_by: string | null;
  created_at: Generated<Timestamp>;
}
export interface IntegrationSyncStatesTable {
  id: Generated<string>;
  organization_id: string;
  integration_id: string;
  dataset: string;
  status: Generated<SyncStatus>;
  cursor: Generated<Json>;
  watermark_at: Timestamp | null;
  last_started_at: Timestamp | null;
  last_succeeded_at: Timestamp | null;
  last_error: string | null;
  consecutive_failures: Generated<number>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}
export interface AnalyticsDailyTable {
  id: Generated<string>;
  organization_id: string;
  integration_id: string;
  provider: IntegrationProvider;
  resource_id: string;
  metric_date: string;
  dimensions: Generated<Json>;
  metrics: Json;
  source_updated_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}
export interface GbpReviewsTable {
  id: Generated<string>;
  organization_id: string;
  integration_id: string;
  location_id: string;
  review_id: string;
  rating: number;
  comment: string | null;
  reviewer_name: string | null;
  review_created_at: Timestamp | null;
  review_updated_at: Timestamp | null;
  reply: Json | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}
export interface SeoProjectsTable {
  id: Generated<string>;
  organization_id: string;
  name: string;
  site_url: string;
  target_location_code: number | null;
  language_code: Generated<string>;
  enabled: Generated<boolean>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}
export interface KeywordsTable {
  id: Generated<string>;
  organization_id: string;
  seo_project_id: string;
  keyword: string;
  tags: Generated<string[]>;
  enabled: Generated<boolean>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}
export interface KeywordRankingsTable {
  id: Generated<string>;
  organization_id: string;
  keyword_id: string;
  checked_on: string;
  rank: number | null;
  url: string | null;
  serp_features: Generated<Json>;
  raw_summary: Generated<Json>;
  created_at: Generated<Timestamp>;
}
export interface CompetitorsTable {
  id: Generated<string>;
  organization_id: string;
  seo_project_id: string;
  domain: string;
  name: string | null;
  metrics: Generated<Json>;
  last_checked_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}
export interface TechnicalAuditsTable {
  id: Generated<string>;
  organization_id: string;
  seo_project_id: string;
  provider_task_id: string | null;
  status: Generated<ProviderTaskStatus>;
  score: number | null;
  issue_count: number | null;
  summary: Generated<Json>;
  started_at: Generated<Timestamp>;
  completed_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}
export interface ProviderTasksTable {
  id: Generated<string>;
  organization_id: string;
  integration_id: string | null;
  provider: IntegrationProvider;
  task_type: string;
  request_fingerprint: string;
  provider_task_id: string | null;
  status: Generated<ProviderTaskStatus>;
  request: Json;
  result: Json | null;
  cost_micro_usd: Generated<string>;
  attempts: Generated<number>;
  next_poll_at: Timestamp | null;
  error: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}
export interface GithubInstallationsTable {
  id: Generated<string>;
  organization_id: string;
  integration_id: string;
  installation_id: string;
  account_login: string;
  account_type: string;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}
export interface GithubRepositoriesTable {
  id: Generated<string>;
  organization_id: string;
  installation_id: string;
  repository_id: string;
  owner: string;
  name: string;
  default_branch: string;
  private: boolean;
  metadata: Generated<Json>;
  analyzed_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}
export interface GithubChangeRequestsTable {
  id: Generated<string>;
  organization_id: string;
  repository_id: string;
  status: Generated<ChangeRequestStatus>;
  title: string;
  description: string | null;
  base_sha: string;
  changes: Json;
  approved_by: string | null;
  approved_at: Timestamp | null;
  branch_name: string | null;
  pull_request_number: number | null;
  pull_request_url: string | null;
  error: string | null;
  created_by: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface ApiKeysTable {
  id: Generated<string>;
  organization_id: string | null;
  name: string;
  key_prefix: string;
  key_hash: string;
  roles: Generated<OrgRole[]>;
  ghl_location_id: string | null;
  expires_at: Timestamp | null;
  revoked_at: Timestamp | null;
  last_used_at: Timestamp | null;
  created_by: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface AiSessionsTable {
  id: Generated<string>;
  organization_id: string;
  user_id: string | null;
  agent: Generated<AgentKind>;
  title: string | null;
  status: Generated<AiSessionStatus>;
  working_memory: Generated<Json>;
  metadata: Generated<Json>;
  last_message_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface ConversationMessagesTable {
  id: Generated<string>;
  session_id: string;
  organization_id: string;
  role: MessageRole;
  content: Generated<string>;
  tool_call_id: string | null;
  tool_name: string | null;
  tool_arguments: Json | null;
  sequence: number;
  metadata: Generated<Json>;
  created_at: Generated<Timestamp>;
}

export interface BusinessMemoryTable {
  id: Generated<string>;
  organization_id: string;
  key: string;
  value: Json;
  source: Generated<string>;
  confidence: string | null;
  expires_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface PromptTemplatesTable {
  id: Generated<string>;
  name: string;
  version: number;
  content: string;
  checksum: string;
  description: string | null;
  is_active: Generated<boolean>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface PromptOverridesTable {
  id: Generated<string>;
  organization_id: string;
  name: string;
  content: string;
  checksum: string;
  reason: string | null;
  created_by: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface AiUsageEventsTable {
  id: Generated<string>;
  organization_id: string;
  session_id: string | null;
  user_id: string | null;
  agent: Generated<AgentKind>;
  requested_model: string;
  served_model: string;
  provider: Generated<string>;
  task_type: Generated<string>;
  prompt_name: string | null;
  prompt_version: number | null;
  prompt_checksum: string | null;
  prompt_tokens: Generated<number>;
  completion_tokens: Generated<number>;
  total_tokens: Generated<number>;
  /** bigint arrives as a string from pg; converted at the repository boundary. */
  cost_micro_usd: Generated<string>;
  latency_ms: number | null;
  fallback_index: Generated<number>;
  succeeded: Generated<boolean>;
  error_code: string | null;
  metadata: Generated<Json>;
  created_at: Generated<Timestamp>;
}

export interface AiBudgetsTable {
  id: Generated<string>;
  organization_id: string;
  period: Generated<BudgetPeriod>;
  limit_micro_usd: string;
  soft_threshold: Generated<string>;
  enforce_hard_limit: Generated<boolean>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface AiBudgetAlertsTable {
  id: Generated<string>;
  organization_id: string;
  budget_id: string;
  kind: BudgetAlertKind;
  period_start: Timestamp;
  spend_micro_usd: string;
  limit_micro_usd: string;
  created_at: Generated<Timestamp>;
}

export interface DomainEventsTable {
  id: Generated<string>;
  type: string;
  organization_id: string;
  aggregate_type: string | null;
  aggregate_id: string | null;
  payload_version: Generated<number>;
  payload: Generated<Json>;
  sequence: string | null;
  published_at: Timestamp | null;
  consumed_at: Timestamp | null;
  claimed_at: Timestamp | null;
  claim_token: string | null;
  attempts: Generated<number>;
  max_attempts: Generated<number>;
  last_error: string | null;
  created_at: Generated<Timestamp>;
}

export interface InsightsTable {
  id: Generated<string>;
  organization_id: string;
  category: InsightCategory;
  severity: Generated<InsightSeverity>;
  status: Generated<InsightStatus>;
  source_generator: string;
  source_event_id: string | null;
  dedupe_key: string | null;
  title: string;
  body: string;
  payload: Generated<Json>;
  confidence: string | null;
  expires_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface RecommendationsTable {
  id: Generated<string>;
  organization_id: string;
  source_insight_id: string | null;
  category: InsightCategory;
  priority: Generated<RecommendationPriority>;
  status: Generated<RecommendationStatus>;
  dedupe_key: string;
  title: string;
  rationale: string;
  action: string;
  expected_impact: string | null;
  owner_role: OrgRole | null;
  evidence: Generated<Json>;
  confidence: string | null;
  due_at: Timestamp | null;
  expires_at: Timestamp | null;
  created_by: string | null;
  approved_by: string | null;
  approved_at: Timestamp | null;
  completed_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface RecommendationHistoryTable {
  id: Generated<string>;
  organization_id: string;
  recommendation_id: string;
  from_status: RecommendationStatus | null;
  to_status: RecommendationStatus;
  reason: string | null;
  changed_by: string | null;
  snapshot: Generated<Json>;
  created_at: Generated<Timestamp>;
}

export interface DashboardMetricsTable {
  id: Generated<string>;
  organization_id: string;
  dashboard: DashboardKind;
  metric_date: string;
  metric_name: string;
  metric_value: string;
  unit: Generated<string>;
  dimension_key: Generated<string>;
  dimension_value: Generated<string>;
  source: string;
  generated_at: Generated<Timestamp>;
}

export interface ExecutiveReportsTable {
  id: Generated<string>;
  organization_id: string;
  period_start: string;
  period_end: string;
  status: Generated<string>;
  title: string;
  content: string;
  metrics: Generated<Json>;
  generated_at: Generated<Timestamp>;
}
export interface AutomationActionsTable {
  id: Generated<string>;
  organization_id: string;
  recommendation_id: string | null;
  integration_id: string;
  kind: AutomationKind;
  status: Generated<AutomationStatus>;
  title: string;
  payload: Json;
  result: Json | null;
  error: string | null;
  created_by: string | null;
  approved_by: string | null;
  approved_at: Timestamp | null;
  executed_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}
export interface GeneratedArtifactsTable {
  id: Generated<string>;
  organization_id: string;
  kind: ArtifactKind;
  artifact_date: string;
  title: string;
  content: string;
  evidence: Generated<Json>;
  status: Generated<string>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface FeatureFlagsTable {
  id: Generated<string>;
  key: string;
  description: string | null;
  default_enabled: Generated<boolean>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface OrganizationFeatureFlagsTable {
  id: Generated<string>;
  organization_id: string;
  flag_id: string;
  enabled: boolean;
  changed_by: string | null;
  reason: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface ScheduledJobsTable {
  id: Generated<string>;
  organization_id: string | null;
  job_type: string;
  name: string;
  schedule: string;
  enabled: Generated<boolean>;
  last_run_at: Timestamp | null;
  next_run_at: Timestamp | null;
  payload: Generated<Json>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface JobRunsTable {
  id: Generated<string>;
  organization_id: string | null;
  scheduled_job_id: string | null;
  job_type: string;
  status: Generated<JobStatus>;
  payload: Generated<Json>;
  result: Json | null;
  error: string | null;
  attempts: Generated<number>;
  max_attempts: Generated<number>;
  next_retry_at: Timestamp | null;
  lease_until: Timestamp | null;
  claimed_by: string | null;
  started_at: Timestamp | null;
  finished_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}

export interface WebhookLogsTable {
  id: Generated<string>;
  organization_id: string | null;
  provider: string;
  event_type: string | null;
  headers: Generated<Json>;
  body: Generated<Json>;
  signature_valid: boolean | null;
  processing_status: string | null;
  processing_error: string | null;
  provider_event_id: string | null;
  payload_hash: string | null;
  received_at: Generated<Timestamp>;
  created_at: Generated<Timestamp>;
}

export interface AuditLogsTable {
  id: Generated<string>;
  organization_id: string | null;
  user_id: string | null;
  actor_role: OrgRole | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  request_id: string | null;
  metadata: Generated<Json>;
  created_at: Generated<Timestamp>;
}

export interface SystemLogsTable {
  id: Generated<string>;
  level: string;
  scope: string;
  message: string;
  context: Generated<Json>;
  created_at: Generated<Timestamp>;
}

export interface RagDocumentsTable {
  id: Generated<string>;
  organization_id: string | null;
  visibility: RagVisibility;
  title: string;
  description: string | null;
  source_filename: string;
  source_mime_type: string;
  source_bytes: string;
  storage_path: string;
  source_checksum: string;
  status: Generated<RagDocumentStatus>;
  active_version_id: string | null;
  created_by: string | null;
  updated_by: string | null;
  error_message: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface RagDocumentVersionsTable {
  id: Generated<string>;
  document_id: string;
  version_number: number;
  source_checksum: string;
  parser_fingerprint: string;
  chunker_fingerprint: string;
  embedding_fingerprint: string;
  status: Generated<RagVersionStatus>;
  chunk_count: Generated<number>;
  error_message: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface RagChunksTable {
  id: Generated<string>;
  version_id: string;
  sequence: number;
  content: string;
  content_checksum: string;
  character_count: number;
  token_count: number | null;
  section: string | null;
  page_number: number | null;
  source_start: number | null;
  source_end: number | null;
  created_at: Generated<Timestamp>;
}

export interface RagVectorPointsTable {
  point_id: string;
  document_id: string;
  version_id: string;
  organization_id: string | null;
  visibility: RagVisibility;
  /** pgvector is encoded as its text representation at the Kysely boundary. */
  embedding: string;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface RagIngestionJobsTable {
  id: Generated<string>;
  organization_id: string | null;
  document_id: string;
  version_id: string | null;
  operation: RagJobOperation;
  status: Generated<RagJobStatus>;
  idempotency_key: string;
  attempts: Generated<number>;
  max_attempts: Generated<number>;
  next_retry_at: Timestamp | null;
  lease_until: Timestamp | null;
  claimed_by: string | null;
  error_message: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

/**
 * The full database interface. Table keys are schema-qualified because Capere's
 * objects live in the `capere` schema, never `public`.
 */
export interface Database {
  'capere.organizations': OrganizationsTable;
  'capere.users': UsersTable;
  'capere.organization_members': OrganizationMembersTable;
  'capere.ghl_locations': GhlLocationsTable;
  'capere.integrations': IntegrationsTable;
  'capere.integration_authorizations': IntegrationAuthorizationsTable;
  'capere.oauth_states': OauthStatesTable;
  'capere.integration_sync_states': IntegrationSyncStatesTable;
  'capere.analytics_daily': AnalyticsDailyTable;
  'capere.gbp_reviews': GbpReviewsTable;
  'capere.seo_projects': SeoProjectsTable;
  'capere.keywords': KeywordsTable;
  'capere.keyword_rankings': KeywordRankingsTable;
  'capere.competitors': CompetitorsTable;
  'capere.technical_audits': TechnicalAuditsTable;
  'capere.provider_tasks': ProviderTasksTable;
  'capere.github_installations': GithubInstallationsTable;
  'capere.github_repositories': GithubRepositoriesTable;
  'capere.github_change_requests': GithubChangeRequestsTable;
  'capere.api_keys': ApiKeysTable;
  'capere.ai_sessions': AiSessionsTable;
  'capere.conversation_messages': ConversationMessagesTable;
  'capere.business_memory': BusinessMemoryTable;
  'capere.prompt_templates': PromptTemplatesTable;
  'capere.prompt_overrides': PromptOverridesTable;
  'capere.ai_usage_events': AiUsageEventsTable;
  'capere.ai_budgets': AiBudgetsTable;
  'capere.ai_budget_alerts': AiBudgetAlertsTable;
  'capere.domain_events': DomainEventsTable;
  'capere.insights': InsightsTable;
  'capere.recommendations': RecommendationsTable;
  'capere.recommendation_history': RecommendationHistoryTable;
  'capere.dashboard_metrics': DashboardMetricsTable;
  'capere.executive_reports': ExecutiveReportsTable;
  'capere.automation_actions': AutomationActionsTable;
  'capere.generated_artifacts': GeneratedArtifactsTable;
  'capere.feature_flags': FeatureFlagsTable;
  'capere.organization_feature_flags': OrganizationFeatureFlagsTable;
  'capere.scheduled_jobs': ScheduledJobsTable;
  'capere.job_runs': JobRunsTable;
  'capere.webhook_logs': WebhookLogsTable;
  'capere.audit_logs': AuditLogsTable;
  'capere.system_logs': SystemLogsTable;
  'capere.rag_documents': RagDocumentsTable;
  'capere.rag_document_versions': RagDocumentVersionsTable;
  'capere.rag_chunks': RagChunksTable;
  'capere.rag_vector_points': RagVectorPointsTable;
  'capere.rag_ingestion_jobs': RagIngestionJobsTable;
}
