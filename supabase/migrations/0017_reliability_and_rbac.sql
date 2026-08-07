-- Reliability and authorization hardening discovered during the full-codebase audit.

-- The original dashboard uniqueness key omitted `source`, so identical metrics
-- from two integrations/resources collided even though the rows represented
-- different provider data.
DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'capere.dashboard_metrics'::regclass
      AND contype = 'u'
  LOOP
    EXECUTE format('ALTER TABLE capere.dashboard_metrics DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE capere.dashboard_metrics
  ADD CONSTRAINT dashboard_metrics_identity_key UNIQUE (
    organization_id, dashboard, metric_date, metric_name,
    dimension_key, dimension_value, source
  );

-- Tenant isolation remains the outer boundary, while write policies now match
-- the roles allowed by the Nest controllers. Backend workers use the service
-- role and therefore remain unaffected.
DROP POLICY IF EXISTS recommendations_all ON capere.recommendations;
CREATE POLICY recommendations_select_member ON capere.recommendations
  FOR SELECT USING (capere.is_org_member(organization_id));
CREATE POLICY recommendations_write_manager ON capere.recommendations
  FOR ALL
  USING (capere.has_org_role(organization_id, ARRAY[
    'owner', 'office_manager', 'marketing_manager', 'seo_specialist', 'capere_admin'
  ]::capere.org_role[]))
  WITH CHECK (capere.has_org_role(organization_id, ARRAY[
    'owner', 'office_manager', 'marketing_manager', 'seo_specialist', 'capere_admin'
  ]::capere.org_role[]));

DROP POLICY IF EXISTS recommendation_history_all ON capere.recommendation_history;
CREATE POLICY recommendation_history_select_member ON capere.recommendation_history
  FOR SELECT USING (capere.is_org_member(organization_id));
CREATE POLICY recommendation_history_write_manager ON capere.recommendation_history
  FOR ALL
  USING (capere.has_org_role(organization_id, ARRAY[
    'owner', 'office_manager', 'marketing_manager', 'seo_specialist', 'capere_admin'
  ]::capere.org_role[]))
  WITH CHECK (capere.has_org_role(organization_id, ARRAY[
    'owner', 'office_manager', 'marketing_manager', 'seo_specialist', 'capere_admin'
  ]::capere.org_role[]));

DROP POLICY IF EXISTS dashboard_metrics_all ON capere.dashboard_metrics;
CREATE POLICY dashboard_metrics_select_member ON capere.dashboard_metrics
  FOR SELECT USING (capere.is_org_member(organization_id));
CREATE POLICY dashboard_metrics_write_manager ON capere.dashboard_metrics
  FOR ALL
  USING (capere.has_org_role(organization_id, ARRAY[
    'owner', 'office_manager', 'marketing_manager', 'seo_specialist', 'capere_admin'
  ]::capere.org_role[]))
  WITH CHECK (capere.has_org_role(organization_id, ARRAY[
    'owner', 'office_manager', 'marketing_manager', 'seo_specialist', 'capere_admin'
  ]::capere.org_role[]));

DROP POLICY IF EXISTS automation_actions_all ON capere.automation_actions;
CREATE POLICY automation_actions_select_member ON capere.automation_actions
  FOR SELECT USING (capere.is_org_member(organization_id));
CREATE POLICY automation_actions_write_manager ON capere.automation_actions
  FOR ALL
  USING (capere.has_org_role(organization_id, ARRAY[
    'owner', 'office_manager', 'marketing_manager', 'capere_admin'
  ]::capere.org_role[]))
  WITH CHECK (capere.has_org_role(organization_id, ARRAY[
    'owner', 'office_manager', 'marketing_manager', 'capere_admin'
  ]::capere.org_role[]));

DROP POLICY IF EXISTS generated_artifacts_all ON capere.generated_artifacts;
CREATE POLICY generated_artifacts_select_member ON capere.generated_artifacts
  FOR SELECT USING (capere.is_org_member(organization_id));
CREATE POLICY generated_artifacts_write_manager ON capere.generated_artifacts
  FOR ALL
  USING (capere.has_org_role(organization_id, ARRAY[
    'owner', 'office_manager', 'marketing_manager', 'seo_specialist', 'capere_admin'
  ]::capere.org_role[]))
  WITH CHECK (capere.has_org_role(organization_id, ARRAY[
    'owner', 'office_manager', 'marketing_manager', 'seo_specialist', 'capere_admin'
  ]::capere.org_role[]));
