-- ===========================================================================
-- 0003_ai_and_hermes.sql
--
-- Hermes sessions, the four memory layers, prompt registry, AI usage accounting
-- and organization AI budgets.
--
-- Cost control note: `ai_usage_events` is the ledger every budget decision
-- reads. It is append-only by policy — corrections are new rows, never updates,
-- so spend history is auditable.
-- ===========================================================================

CREATE TYPE capere.ai_session_status AS ENUM ('active', 'completed', 'failed', 'abandoned');

CREATE TYPE capere.message_role AS ENUM ('system', 'user', 'assistant', 'tool');

CREATE TYPE capere.agent_kind AS ENUM (
  'hermes',       -- the orchestrator itself
  'seo',
  'gbp',
  'analytics',
  'cmo',
  'content',
  'automation',
  'knowledge'
);

CREATE TYPE capere.budget_period AS ENUM ('daily', 'weekly', 'monthly');

CREATE TYPE capere.budget_alert_kind AS ENUM ('soft_threshold', 'hard_limit');

-- --- ai_sessions -----------------------------------------------------------
CREATE TABLE capere.ai_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES capere.organizations(id) ON DELETE CASCADE,
  user_id           uuid REFERENCES capere.users(id) ON DELETE SET NULL,
  -- Null for system-initiated sessions (scheduled briefs, workers).
  agent             capere.agent_kind NOT NULL DEFAULT 'hermes',
  title             text,
  status            capere.ai_session_status NOT NULL DEFAULT 'active',
  -- Working Memory: scratch state for the life of one orchestration run.
  working_memory    jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_message_at   timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_sessions_org      ON capere.ai_sessions (organization_id, created_at DESC);
CREATE INDEX idx_ai_sessions_user     ON capere.ai_sessions (user_id);

COMMENT ON COLUMN capere.ai_sessions.working_memory IS
  'Working Memory layer: ephemeral scratch state scoped to a single orchestration run.';

-- --- conversation_messages (Conversation Memory) ---------------------------
CREATE TABLE capere.conversation_messages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        uuid NOT NULL REFERENCES capere.ai_sessions(id) ON DELETE CASCADE,
  organization_id   uuid NOT NULL REFERENCES capere.organizations(id) ON DELETE CASCADE,
  role              capere.message_role NOT NULL,
  content           text NOT NULL DEFAULT '',
  -- Tool calling: populated for assistant tool-call requests and tool results.
  tool_call_id      text,
  tool_name         text,
  tool_arguments    jsonb,
  -- Ordering within a session. Monotonic per session, assigned by the app.
  sequence          integer NOT NULL,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, sequence)
);

CREATE INDEX idx_messages_session ON capere.conversation_messages (session_id, sequence);
CREATE INDEX idx_messages_org     ON capere.conversation_messages (organization_id);

COMMENT ON TABLE capere.conversation_messages IS
  'Conversation Memory layer: the turn-by-turn transcript of an AI session.';

-- --- business_memory (Business Memory) -------------------------------------
-- Durable, organization-scoped facts Hermes should always know: firm profile,
-- service lines, target markets, current KPIs, stated goals.
CREATE TABLE capere.business_memory (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES capere.organizations(id) ON DELETE CASCADE,
  -- Dotted namespace, e.g. 'firm.profile', 'goals.q3', 'kpi.lead_target'.
  key               text NOT NULL CHECK (length(trim(key)) > 0),
  value             jsonb NOT NULL,
  -- Where this came from: 'user', 'ga4_sync', 'insight', 'onboarding'.
  source            text NOT NULL DEFAULT 'user',
  confidence        numeric(3, 2) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  expires_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, key)
);

CREATE INDEX idx_business_memory_org ON capere.business_memory (organization_id);

COMMENT ON TABLE capere.business_memory IS
  'Business Memory layer: durable per-organization facts injected into Hermes context.';

-- --- prompt_templates + overrides ------------------------------------------
-- Files are the source of truth (reviewed in PRs, tested in CI). This table
-- mirrors registered versions and allows per-org overrides without a deploy.
CREATE TABLE capere.prompt_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stable identifier, e.g. 'hermes.system', 'agent.seo.analyze'.
  name          text NOT NULL,
  version       integer NOT NULL CHECK (version >= 1),
  content       text NOT NULL,
  -- SHA-256 of content. Recorded on every usage event so an output can always
  -- be traced back to the exact prompt revision that produced it.
  checksum      text NOT NULL,
  description   text,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, version)
);

CREATE INDEX idx_prompt_templates_name ON capere.prompt_templates (name, version DESC);

CREATE TABLE capere.prompt_overrides (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES capere.organizations(id) ON DELETE CASCADE,
  name              text NOT NULL,
  content           text NOT NULL,
  checksum          text NOT NULL,
  reason            text,
  created_by        uuid REFERENCES capere.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

COMMENT ON TABLE capere.prompt_overrides IS
  'Per-organization prompt override. Files remain the default; this enables A/B tests and customization without a deploy.';

-- --- ai_usage_events (the cost ledger) -------------------------------------
CREATE TABLE capere.ai_usage_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES capere.organizations(id) ON DELETE CASCADE,
  session_id            uuid REFERENCES capere.ai_sessions(id) ON DELETE SET NULL,
  user_id               uuid REFERENCES capere.users(id) ON DELETE SET NULL,
  agent                 capere.agent_kind NOT NULL DEFAULT 'hermes',
  -- Routing: what was asked for vs what actually served it after fallback.
  requested_model       text NOT NULL,
  served_model          text NOT NULL,
  provider              text NOT NULL DEFAULT 'openrouter',
  task_type             text NOT NULL DEFAULT 'general',
  prompt_name           text,
  prompt_version        integer,
  prompt_checksum       text,
  prompt_tokens         integer NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
  completion_tokens     integer NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
  total_tokens          integer NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
  -- Micro-USD (1e-6 USD) as an exact integer. Floating-point money is a bug
  -- waiting to happen; per-call costs are far below a cent.
  cost_micro_usd        bigint NOT NULL DEFAULT 0 CHECK (cost_micro_usd >= 0),
  latency_ms            integer,
  -- Fallback chain position that succeeded: 0 = primary model.
  fallback_index        integer NOT NULL DEFAULT 0,
  succeeded             boolean NOT NULL DEFAULT true,
  error_code            text,
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_usage_org_time ON capere.ai_usage_events (organization_id, created_at DESC);
CREATE INDEX idx_usage_session  ON capere.ai_usage_events (session_id);

COMMENT ON TABLE capere.ai_usage_events IS
  'Append-only ledger of every model call: tokens, cost in micro-USD, latency, prompt revision. Basis for budgets and margin analysis.';
COMMENT ON COLUMN capere.ai_usage_events.cost_micro_usd IS
  'Cost in millionths of a USD, stored as an exact integer to avoid floating-point money errors.';

-- --- ai_budgets ------------------------------------------------------------
CREATE TABLE capere.ai_budgets (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid NOT NULL REFERENCES capere.organizations(id) ON DELETE CASCADE,
  period                    capere.budget_period NOT NULL DEFAULT 'monthly',
  -- Hard ceiling. Calls are refused once spend reaches this.
  limit_micro_usd           bigint NOT NULL CHECK (limit_micro_usd > 0),
  -- Fraction of the limit that triggers a warning event, e.g. 0.80.
  soft_threshold            numeric(3, 2) NOT NULL DEFAULT 0.80
                              CHECK (soft_threshold > 0 AND soft_threshold <= 1),
  -- When false, exceeding the limit warns but does not block.
  enforce_hard_limit        boolean NOT NULL DEFAULT true,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, period)
);

CREATE TABLE capere.ai_budget_alerts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES capere.organizations(id) ON DELETE CASCADE,
  budget_id         uuid NOT NULL REFERENCES capere.ai_budgets(id) ON DELETE CASCADE,
  kind              capere.budget_alert_kind NOT NULL,
  -- The period this alert refers to, truncated to the period start.
  period_start      date NOT NULL,
  spend_micro_usd   bigint NOT NULL,
  limit_micro_usd   bigint NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- One alert per kind per period: prevents alert storms on every call.
  UNIQUE (budget_id, kind, period_start)
);

CREATE INDEX idx_budget_alerts_org ON capere.ai_budget_alerts (organization_id, created_at DESC);

COMMENT ON TABLE capere.ai_budget_alerts IS
  'Deduplicated budget alerts — unique on (budget, kind, period) so a threshold fires once per period, not once per call.';

-- --- RLS -------------------------------------------------------------------
ALTER TABLE capere.ai_sessions           ENABLE ROW LEVEL SECURITY;
ALTER TABLE capere.conversation_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE capere.business_memory       ENABLE ROW LEVEL SECURITY;
ALTER TABLE capere.prompt_overrides      ENABLE ROW LEVEL SECURITY;
ALTER TABLE capere.ai_usage_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE capere.ai_budgets            ENABLE ROW LEVEL SECURITY;
ALTER TABLE capere.ai_budget_alerts      ENABLE ROW LEVEL SECURITY;

ALTER TABLE capere.ai_sessions           FORCE ROW LEVEL SECURITY;
ALTER TABLE capere.conversation_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE capere.business_memory       FORCE ROW LEVEL SECURITY;
ALTER TABLE capere.prompt_overrides      FORCE ROW LEVEL SECURITY;
ALTER TABLE capere.ai_usage_events       FORCE ROW LEVEL SECURITY;
ALTER TABLE capere.ai_budgets            FORCE ROW LEVEL SECURITY;
ALTER TABLE capere.ai_budget_alerts      FORCE ROW LEVEL SECURITY;

CREATE POLICY ai_sessions_all ON capere.ai_sessions
  FOR ALL TO authenticated
  USING (capere.is_org_member(organization_id))
  WITH CHECK (capere.is_org_member(organization_id));

CREATE POLICY messages_all ON capere.conversation_messages
  FOR ALL TO authenticated
  USING (capere.is_org_member(organization_id))
  WITH CHECK (capere.is_org_member(organization_id));

CREATE POLICY business_memory_all ON capere.business_memory
  FOR ALL TO authenticated
  USING (capere.is_org_member(organization_id))
  WITH CHECK (capere.is_org_member(organization_id));

CREATE POLICY prompt_overrides_all ON capere.prompt_overrides
  FOR ALL TO authenticated
  USING (capere.is_org_member(organization_id))
  WITH CHECK (capere.is_org_member(organization_id));

-- Usage is readable by members but never mutable by them: the ledger is written
-- by the service role only. This keeps spend records tamper-evident.
CREATE POLICY usage_select ON capere.ai_usage_events
  FOR SELECT TO authenticated
  USING (capere.is_org_member(organization_id));

CREATE POLICY budgets_select ON capere.ai_budgets
  FOR SELECT TO authenticated
  USING (capere.is_org_member(organization_id));

-- Only owners/admins may change a budget.
CREATE POLICY budgets_write ON capere.ai_budgets
  FOR ALL TO authenticated
  USING (capere.has_org_role(organization_id, ARRAY['owner', 'capere_admin']::capere.org_role[]))
  WITH CHECK (capere.has_org_role(organization_id, ARRAY['owner', 'capere_admin']::capere.org_role[]));

CREATE POLICY budget_alerts_select ON capere.ai_budget_alerts
  FOR SELECT TO authenticated
  USING (capere.is_org_member(organization_id));

-- prompt_templates is global (not org-scoped): readable by all authenticated
-- users, writable only by the service role.
ALTER TABLE capere.prompt_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE capere.prompt_templates FORCE ROW LEVEL SECURITY;

CREATE POLICY prompt_templates_select ON capere.prompt_templates
  FOR SELECT TO authenticated
  USING (true);

-- --- updated_at triggers ---------------------------------------------------
CREATE TRIGGER trg_ai_sessions_updated_at
  BEFORE UPDATE ON capere.ai_sessions
  FOR EACH ROW EXECUTE FUNCTION capere.set_updated_at();

CREATE TRIGGER trg_business_memory_updated_at
  BEFORE UPDATE ON capere.business_memory
  FOR EACH ROW EXECUTE FUNCTION capere.set_updated_at();

CREATE TRIGGER trg_prompt_templates_updated_at
  BEFORE UPDATE ON capere.prompt_templates
  FOR EACH ROW EXECUTE FUNCTION capere.set_updated_at();

CREATE TRIGGER trg_prompt_overrides_updated_at
  BEFORE UPDATE ON capere.prompt_overrides
  FOR EACH ROW EXECUTE FUNCTION capere.set_updated_at();

CREATE TRIGGER trg_ai_budgets_updated_at
  BEFORE UPDATE ON capere.ai_budgets
  FOR EACH ROW EXECUTE FUNCTION capere.set_updated_at();
