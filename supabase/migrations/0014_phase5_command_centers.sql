-- Phase 5: recommendation lifecycle and precomputed reporting marts.

-- `recommendations` references `insights (organization_id, id)` with a composite
-- FK so a recommendation can never cite another tenant's insight — the pattern
-- established in 0005_composite_tenant_fks.sql.
--
-- Postgres requires a UNIQUE constraint matching the referenced columns, and
-- 0005 added one to every parent that HAD a child at the time. `insights` did
-- not, so it was skipped; this is the first migration to reference it. Without
-- this the FK below fails with "no unique constraint matching given keys".
--
-- `id` is already the primary key, so this is redundant for uniqueness. It
-- exists solely to be a valid composite FK target.
ALTER TABLE capere.insights
  ADD CONSTRAINT insights_org_id_key UNIQUE (organization_id, id);

CREATE TYPE capere.recommendation_priority AS ENUM ('low', 'medium', 'high', 'critical');
CREATE TYPE capere.recommendation_status AS ENUM (
  'proposed', 'approved', 'in_progress', 'completed', 'dismissed', 'expired'
);
CREATE TYPE capere.dashboard_kind AS ENUM (
  'executive', 'seo', 'gbp', 'lead', 'revenue', 'content'
);

ALTER TABLE capere.insights
  ADD CONSTRAINT insights_organization_id_id_key UNIQUE (organization_id, id);

CREATE TABLE capere.recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES capere.organizations(id) ON DELETE CASCADE,
  source_insight_id uuid,
  category capere.insight_category NOT NULL,
  priority capere.recommendation_priority NOT NULL DEFAULT 'medium',
  status capere.recommendation_status NOT NULL DEFAULT 'proposed',
  dedupe_key text NOT NULL,
  title text NOT NULL,
  rationale text NOT NULL,
  action text NOT NULL,
  expected_impact text,
  owner_role capere.org_role,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence numeric(3, 2) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  due_at timestamptz,
  expires_at timestamptz,
  created_by uuid REFERENCES capere.users(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES capere.users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, dedupe_key),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, source_insight_id)
    REFERENCES capere.insights (organization_id, id) ON DELETE SET NULL
);

CREATE INDEX idx_recommendations_org_status
  ON capere.recommendations (organization_id, status, priority, created_at DESC);

CREATE TABLE capere.recommendation_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES capere.organizations(id) ON DELETE CASCADE,
  recommendation_id uuid NOT NULL,
  from_status capere.recommendation_status,
  to_status capere.recommendation_status NOT NULL,
  reason text,
  changed_by uuid REFERENCES capere.users(id) ON DELETE SET NULL,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, recommendation_id)
    REFERENCES capere.recommendations (organization_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_recommendation_history_org_recommendation
  ON capere.recommendation_history (organization_id, recommendation_id, created_at DESC);

CREATE TABLE capere.dashboard_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES capere.organizations(id) ON DELETE CASCADE,
  dashboard capere.dashboard_kind NOT NULL,
  metric_date date NOT NULL,
  metric_name text NOT NULL,
  metric_value numeric NOT NULL,
  unit text NOT NULL DEFAULT 'count',
  dimension_key text NOT NULL DEFAULT '',
  dimension_value text NOT NULL DEFAULT '',
  source text NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (
    organization_id, dashboard, metric_date, metric_name, dimension_key, dimension_value
  )
);

CREATE INDEX idx_dashboard_metrics_looker
  ON capere.dashboard_metrics (organization_id, dashboard, metric_date DESC, metric_name);

ALTER TABLE capere.recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE capere.recommendation_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE capere.dashboard_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE capere.recommendations FORCE ROW LEVEL SECURITY;
ALTER TABLE capere.recommendation_history FORCE ROW LEVEL SECURITY;
ALTER TABLE capere.dashboard_metrics FORCE ROW LEVEL SECURITY;

CREATE POLICY recommendations_all ON capere.recommendations
  FOR ALL USING (capere.is_org_member(organization_id))
  WITH CHECK (capere.is_org_member(organization_id));
CREATE POLICY recommendation_history_all ON capere.recommendation_history
  FOR ALL USING (capere.is_org_member(organization_id))
  WITH CHECK (capere.is_org_member(organization_id));
CREATE POLICY dashboard_metrics_all ON capere.dashboard_metrics
  FOR ALL USING (capere.is_org_member(organization_id))
  WITH CHECK (capere.is_org_member(organization_id));

CREATE TRIGGER trg_recommendations_updated_at
  BEFORE UPDATE ON capere.recommendations
  FOR EACH ROW EXECUTE FUNCTION capere.set_updated_at();

COMMENT ON TABLE capere.dashboard_metrics IS
  'Precomputed long-form metrics consumed by Looker Studio and GHL custom modules; never raw CRM entities.';
