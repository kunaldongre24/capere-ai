-- ===========================================================================
-- 0004_events_insights_flags.sql
--
-- Cross-cutting platform pieces:
--   - domain_events: the transactional outbox behind the event bus
--   - insights: the Insights Engine's store
--   - feature_flags: organization-level rollout controls
--   - scheduled_jobs / job_runs: job metadata and execution history
--   - webhook_logs / audit_logs / system_logs: observability
-- ===========================================================================

-- --- domain_events (transactional outbox) ----------------------------------
-- Written in the SAME transaction as the state change it describes, so an
-- event cannot exist without its cause. A relay worker moves rows to BullMQ.
CREATE TABLE capere.domain_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Event type, e.g. 'integration.connected', 'recommendation.generated'.
  type              text NOT NULL,
  organization_id   uuid NOT NULL REFERENCES capere.organizations(id) ON DELETE CASCADE,
  aggregate_type    text,
  aggregate_id      uuid,
  -- Versioned payload shape, e.g. 1. Bump on incompatible payload changes.
  payload_version   integer NOT NULL DEFAULT 1,
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Monotonic ordering key within an aggregate; guarantees order for consumers.
  sequence          bigint,
  -- Exactly-once consumption.
  published_at      timestamptz,
  consumed_at       timestamptz,
  -- Delivery bookkeeping. attempts > max_attempts moves the event to the DLQ.
  attempts          integer NOT NULL DEFAULT 0,
  max_attempts      integer NOT NULL DEFAULT 5,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Outbox fan-out: the relay needs pending events, and ordering is per-aggregate.
CREATE INDEX idx_domain_events_pending
  ON capere.domain_events (created_at)
  WHERE published_at IS NULL;

CREATE INDEX idx_domain_events_type_time ON capere.domain_events (type, created_at DESC);

COMMENT ON TABLE capere.domain_events IS
  'Transactional outbox. Events are written atomically with their cause and relayed to BullMQ by the worker.';

-- --- insights --------------------------------------------------------------
CREATE TYPE capere.insight_category AS ENUM (
  'analytics',
  'seo',
  'gbp',
  'revenue',
  'operations',
  'marketing'
);

CREATE TYPE capere.insight_severity AS ENUM ('info', 'low', 'medium', 'high', 'critical');

CREATE TYPE capere.insight_status AS ENUM ('active', 'expired', 'dismissed', 'applied');

CREATE TABLE capere.insights (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES capere.organizations(id) ON DELETE CASCADE,
  category            capere.insight_category NOT NULL,
  severity            capere.insight_severity NOT NULL DEFAULT 'info',
  status              capere.insight_status NOT NULL DEFAULT 'active',
  -- Slug of the generator that produced this, e.g. 'integration_disconnected'.
  source_generator    text NOT NULL,
  -- The domain event that triggered this insight (nullable for manual/seed).
  source_event_id     uuid REFERENCES capere.domain_events(id) ON DELETE SET NULL,
  -- Deduplication: a generator emitting the same signal twice shouldn't double.
  dedupe_key          text,
  title               text NOT NULL,
  body                text NOT NULL,
  -- Structured facts for dashboards and the recommendation engine.
  payload             jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence          numeric(3, 2) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  expires_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, dedupe_key)
);

CREATE INDEX idx_insights_org_time ON capere.insights (organization_id, created_at DESC);
CREATE INDEX idx_insights_status   ON capere.insights (status, expires_at);

COMMENT ON TABLE capere.insights IS
  'Reusable, typed findings produced by the Insights Engine — the layer between analytics and the CMO Agent.';

-- --- feature_flags ---------------------------------------------------------
CREATE TABLE capere.feature_flags (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key             text NOT NULL UNIQUE,
  description     text,
  -- Global default before any organization-level override.
  default_enabled boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE capere.organization_feature_flags (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES capere.organizations(id) ON DELETE CASCADE,
  flag_id           uuid NOT NULL REFERENCES capere.feature_flags(id) ON DELETE CASCADE,
  enabled           boolean NOT NULL,
  changed_by        uuid REFERENCES capere.users(id) ON DELETE SET NULL,
  reason            text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, flag_id)
);

CREATE INDEX idx_org_feature_flags_org ON capere.organization_feature_flags (organization_id);

COMMENT ON TABLE capere.feature_flags IS
  'Global flag catalog. Organization-level overrides enable beta features and gradual rollouts.';

-- --- scheduled_jobs / job_runs ---------------------------------------------
CREATE TYPE capere.job_status AS ENUM ('scheduled', 'running', 'succeeded', 'failed', 'dead_lettered');

CREATE TABLE capere.scheduled_jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid REFERENCES capere.organizations(id) ON DELETE CASCADE,
  -- Worker/queue name, e.g. 'analytics-sync', 'seo-audit'.
  job_type          text NOT NULL,
  name              text NOT NULL,
  -- Cron expression (e.g. '0 3 * * *') or interval shorthand ('daily').
  schedule          text NOT NULL,
  enabled           boolean NOT NULL DEFAULT true,
  last_run_at       timestamptz,
  next_run_at       timestamptz,
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE INDEX idx_scheduled_jobs_due ON capere.scheduled_jobs (enabled, next_run_at);

CREATE TABLE capere.job_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid REFERENCES capere.organizations(id) ON DELETE CASCADE,
  scheduled_job_id  uuid REFERENCES capere.scheduled_jobs(id) ON DELETE CASCADE,
  job_type          text NOT NULL,
  status            capere.job_status NOT NULL DEFAULT 'scheduled',
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  result            jsonb,
  error             text,
  attempts          integer NOT NULL DEFAULT 0,
  started_at        timestamptz,
  finished_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_job_runs_org_time ON capere.job_runs (organization_id, created_at DESC);
CREATE INDEX idx_job_runs_status   ON capere.job_runs (status, created_at);

COMMENT ON TABLE capere.job_runs IS
  'Execution history for every background job — the basis for the job monitoring view.';

-- --- observability ---------------------------------------------------------
CREATE TABLE capere.webhook_logs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid REFERENCES capere.organizations(id) ON DELETE CASCADE,
  provider          text NOT NULL,
  event_type        text,
  headers           jsonb NOT NULL DEFAULT '{}'::jsonb,
  body              jsonb NOT NULL DEFAULT '{}'::jsonb,
  signature_valid   boolean,
  processing_status text,
  processing_error  text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_webhook_logs_org_time ON capere.webhook_logs (organization_id, created_at DESC);

COMMENT ON TABLE capere.webhook_logs IS
  'Inbound webhook trail: what arrived, whether its signature checked out, and what happened to it.';

CREATE TABLE capere.audit_logs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid REFERENCES capere.organizations(id) ON DELETE CASCADE,
  user_id           uuid REFERENCES capere.users(id) ON DELETE SET NULL,
  actor_role        capere.org_role,
  action            text NOT NULL,
  resource_type     text,
  resource_id       uuid,
  ip_address        inet,
  user_agent        text,
  request_id        text,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_logs_org_time ON capere.audit_logs (organization_id, created_at DESC);
CREATE INDEX idx_audit_logs_user_time ON capere.audit_logs (user_id, created_at DESC);

COMMENT ON TABLE capere.audit_logs IS
  'Append-only security audit trail: who did what, from where, with what request context.';

CREATE TABLE capere.system_logs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  level             text NOT NULL,
  scope             text NOT NULL,
  message           text NOT NULL,
  context           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_system_logs_time ON capere.system_logs (created_at DESC);
CREATE INDEX idx_system_logs_scope ON capere.system_logs (scope, created_at DESC);

COMMENT ON TABLE capere.system_logs IS
  'System-level operational log (boot, migrations, worker lifecycle). Application logs are structured pino.';

-- --- RLS -------------------------------------------------------------------
ALTER TABLE capere.domain_events           ENABLE ROW LEVEL SECURITY;
ALTER TABLE capere.insights                ENABLE ROW LEVEL SECURITY;
ALTER TABLE capere.organization_feature_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE capere.scheduled_jobs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE capere.job_runs                ENABLE ROW LEVEL SECURITY;
ALTER TABLE capere.webhook_logs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE capere.audit_logs              ENABLE ROW LEVEL SECURITY;

ALTER TABLE capere.domain_events           FORCE ROW LEVEL SECURITY;
ALTER TABLE capere.insights                FORCE ROW LEVEL SECURITY;
ALTER TABLE capere.organization_feature_flags FORCE ROW LEVEL SECURITY;
ALTER TABLE capere.scheduled_jobs          FORCE ROW LEVEL SECURITY;
ALTER TABLE capere.job_runs                FORCE ROW LEVEL SECURITY;
ALTER TABLE capere.webhook_logs            FORCE ROW LEVEL SECURITY;
ALTER TABLE capere.audit_logs              FORCE ROW LEVEL SECURITY;

-- Global catalog: readable by every authenticated user; overrides are org-scoped.
ALTER TABLE capere.feature_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE capere.feature_flags FORCE ROW LEVEL SECURITY;

CREATE POLICY feature_flags_select ON capere.feature_flags
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY organization_feature_flags_all ON capere.organization_feature_flags
  FOR ALL TO authenticated
  USING (capere.is_org_member(organization_id))
  WITH CHECK (capere.is_org_member(organization_id));

CREATE POLICY domain_events_select ON capere.domain_events
  FOR SELECT TO authenticated
  USING (capere.is_org_member(organization_id));

CREATE POLICY insights_all ON capere.insights
  FOR ALL TO authenticated
  USING (capere.is_org_member(organization_id))
  WITH CHECK (capere.is_org_member(organization_id));

CREATE POLICY scheduled_jobs_all ON capere.scheduled_jobs
  FOR ALL TO authenticated
  USING (capere.is_org_member(organization_id))
  WITH CHECK (capere.is_org_member(organization_id));

CREATE POLICY job_runs_all ON capere.job_runs
  FOR ALL TO authenticated
  USING (capere.is_org_member(organization_id))
  WITH CHECK (capere.is_org_member(organization_id));

CREATE POLICY webhook_logs_select ON capere.webhook_logs
  FOR SELECT TO authenticated
  USING (capere.is_org_member(organization_id));

CREATE POLICY audit_logs_select ON capere.audit_logs
  FOR SELECT TO authenticated
  USING (capere.is_org_member(organization_id));

-- system_logs is not tenant-scoped; it is written by the service role only.
ALTER TABLE capere.system_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE capere.system_logs FORCE ROW LEVEL SECURITY;

CREATE POLICY system_logs_select ON capere.system_logs
  FOR SELECT TO service_role
  USING (true);

-- --- updated_at triggers ---------------------------------------------------
CREATE TRIGGER trg_insights_updated_at
  BEFORE UPDATE ON capere.insights
  FOR EACH ROW EXECUTE FUNCTION capere.set_updated_at();

CREATE TRIGGER trg_feature_flags_updated_at
  BEFORE UPDATE ON capere.feature_flags
  FOR EACH ROW EXECUTE FUNCTION capere.set_updated_at();

CREATE TRIGGER trg_org_feature_flags_updated_at
  BEFORE UPDATE ON capere.organization_feature_flags
  FOR EACH ROW EXECUTE FUNCTION capere.set_updated_at();

CREATE TRIGGER trg_scheduled_jobs_updated_at
  BEFORE UPDATE ON capere.scheduled_jobs
  FOR EACH ROW EXECUTE PROCEDURE capere.set_updated_at();
