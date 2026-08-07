CREATE TABLE capere.executive_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES capere.organizations(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  status text NOT NULL DEFAULT 'generated' CHECK (status IN ('generated', 'failed')),
  title text NOT NULL,
  content text NOT NULL,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  generated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, period_start, period_end)
);
ALTER TABLE capere.executive_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE capere.executive_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY executive_reports_all ON capere.executive_reports
  FOR ALL USING (capere.is_org_member(organization_id))
  WITH CHECK (capere.is_org_member(organization_id));
