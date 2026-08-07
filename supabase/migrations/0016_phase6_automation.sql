CREATE TYPE capere.automation_status AS ENUM (
  'draft', 'approved', 'executing', 'succeeded', 'failed', 'cancelled'
);
CREATE TYPE capere.automation_kind AS ENUM ('ghl_task_create', 'ghl_workflow_trigger');
CREATE TYPE capere.artifact_kind AS ENUM ('daily_brief', 'content_draft');

CREATE TABLE capere.automation_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES capere.organizations(id) ON DELETE CASCADE,
  recommendation_id uuid,
  integration_id uuid NOT NULL,
  kind capere.automation_kind NOT NULL,
  status capere.automation_status NOT NULL DEFAULT 'draft',
  title text NOT NULL,
  payload jsonb NOT NULL,
  result jsonb,
  error text,
  created_by uuid REFERENCES capere.users(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES capere.users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  executed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, recommendation_id)
    REFERENCES capere.recommendations (organization_id, id) ON DELETE SET NULL,
  FOREIGN KEY (organization_id, integration_id)
    REFERENCES capere.integrations (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE capere.generated_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES capere.organizations(id) ON DELETE CASCADE,
  kind capere.artifact_kind NOT NULL,
  artifact_date date NOT NULL,
  title text NOT NULL,
  content text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'published')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, kind, artifact_date, title)
);

CREATE INDEX idx_automation_actions_queue
  ON capere.automation_actions (organization_id, status, created_at DESC);
CREATE INDEX idx_generated_artifacts_org_kind
  ON capere.generated_artifacts (organization_id, kind, artifact_date DESC);

ALTER TABLE capere.automation_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE capere.generated_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE capere.automation_actions FORCE ROW LEVEL SECURITY;
ALTER TABLE capere.generated_artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY automation_actions_all ON capere.automation_actions
  FOR ALL USING (capere.is_org_member(organization_id))
  WITH CHECK (capere.is_org_member(organization_id));
CREATE POLICY generated_artifacts_all ON capere.generated_artifacts
  FOR ALL USING (capere.is_org_member(organization_id))
  WITH CHECK (capere.is_org_member(organization_id));
CREATE TRIGGER trg_automation_actions_updated_at BEFORE UPDATE ON capere.automation_actions
  FOR EACH ROW EXECUTE FUNCTION capere.set_updated_at();
CREATE TRIGGER trg_generated_artifacts_updated_at BEFORE UPDATE ON capere.generated_artifacts
  FOR EACH ROW EXECUTE FUNCTION capere.set_updated_at();
