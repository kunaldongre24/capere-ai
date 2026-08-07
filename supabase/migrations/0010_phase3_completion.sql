-- Phase 3: provider authorization, normalized sync data, paid-task dedupe,
-- approved GitHub changes, and replay-safe webhook ingestion.

CREATE TYPE capere.sync_status AS ENUM ('idle', 'queued', 'running', 'succeeded', 'failed');
CREATE TYPE capere.provider_task_status AS ENUM ('submitted', 'polling', 'succeeded', 'failed');
CREATE TYPE capere.change_request_status AS ENUM
  ('draft', 'approved', 'executing', 'pull_request_opened', 'failed', 'cancelled');

CREATE TABLE capere.integration_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES capere.organizations(id) ON DELETE CASCADE,
  provider text NOT NULL,
  external_account_id text,
  external_account_name text,
  encrypted_credentials bytea NOT NULL,
  key_version integer NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  expires_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, provider, external_account_id),
  UNIQUE (organization_id, id)
);

ALTER TABLE capere.integrations
  ADD COLUMN authorization_id uuid,
  ADD COLUMN sync_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE capere.integrations DROP CONSTRAINT integrations_org_provider_location_key;
CREATE UNIQUE INDEX integrations_ghl_identity_key
  ON capere.integrations (organization_id, provider, ghl_location_id)
  WHERE provider = 'go_high_level';
CREATE UNIQUE INDEX integrations_resource_identity_key
  ON capere.integrations (organization_id, provider, account_id)
  WHERE provider <> 'go_high_level';
ALTER TABLE capere.integrations
  ADD CONSTRAINT integrations_org_id_key UNIQUE (organization_id, id);
ALTER TABLE capere.integrations
  ADD CONSTRAINT integrations_authorization_fkey
  FOREIGN KEY (organization_id, authorization_id)
  REFERENCES capere.integration_authorizations (organization_id, id);

CREATE TABLE capere.oauth_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES capere.organizations(id) ON DELETE CASCADE,
  provider text NOT NULL,
  state_hash text NOT NULL UNIQUE,
  encrypted_code_verifier bytea NOT NULL,
  redirect_uri text NOT NULL,
  requested_scopes text[] NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_by uuid REFERENCES capere.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);

CREATE TABLE capere.integration_sync_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES capere.organizations(id) ON DELETE CASCADE,
  integration_id uuid NOT NULL,
  dataset text NOT NULL,
  status capere.sync_status NOT NULL DEFAULT 'idle',
  cursor jsonb NOT NULL DEFAULT '{}'::jsonb,
  watermark_at timestamptz,
  last_started_at timestamptz,
  last_succeeded_at timestamptz,
  last_error text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, integration_id, dataset),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, integration_id)
    REFERENCES capere.integrations (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE capere.analytics_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES capere.organizations(id) ON DELETE CASCADE,
  integration_id uuid NOT NULL,
  provider capere.integration_provider NOT NULL,
  resource_id text NOT NULL,
  metric_date date NOT NULL,
  dimensions jsonb NOT NULL DEFAULT '{}'::jsonb,
  metrics jsonb NOT NULL,
  source_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, provider, resource_id, metric_date, dimensions),
  FOREIGN KEY (organization_id, integration_id)
    REFERENCES capere.integrations (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_analytics_daily_org_provider_date
  ON capere.analytics_daily (organization_id, provider, metric_date DESC);

CREATE TABLE capere.gbp_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES capere.organizations(id) ON DELETE CASCADE,
  integration_id uuid NOT NULL,
  location_id text NOT NULL,
  review_id text NOT NULL,
  rating integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment text,
  reviewer_name text,
  review_created_at timestamptz,
  review_updated_at timestamptz,
  reply jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, location_id, review_id),
  FOREIGN KEY (organization_id, integration_id)
    REFERENCES capere.integrations (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE capere.seo_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES capere.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  site_url text NOT NULL,
  target_location_code integer,
  language_code text NOT NULL DEFAULT 'en',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, site_url),
  UNIQUE (organization_id, id)
);

CREATE TABLE capere.keywords (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES capere.organizations(id) ON DELETE CASCADE,
  seo_project_id uuid NOT NULL,
  keyword text NOT NULL,
  tags text[] NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, seo_project_id, keyword),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, seo_project_id)
    REFERENCES capere.seo_projects (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE capere.keyword_rankings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES capere.organizations(id) ON DELETE CASCADE,
  keyword_id uuid NOT NULL,
  checked_on date NOT NULL,
  rank integer,
  url text,
  serp_features jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, keyword_id, checked_on),
  FOREIGN KEY (organization_id, keyword_id)
    REFERENCES capere.keywords (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE capere.competitors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES capere.organizations(id) ON DELETE CASCADE,
  seo_project_id uuid NOT NULL,
  domain text NOT NULL,
  name text,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, seo_project_id, domain),
  FOREIGN KEY (organization_id, seo_project_id)
    REFERENCES capere.seo_projects (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE capere.technical_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES capere.organizations(id) ON DELETE CASCADE,
  seo_project_id uuid NOT NULL,
  provider_task_id uuid,
  status capere.provider_task_status NOT NULL DEFAULT 'submitted',
  score integer CHECK (score BETWEEN 0 AND 100),
  issue_count integer,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, seo_project_id)
    REFERENCES capere.seo_projects (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE capere.provider_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES capere.organizations(id) ON DELETE CASCADE,
  integration_id uuid,
  provider capere.integration_provider NOT NULL,
  task_type text NOT NULL,
  request_fingerprint text NOT NULL,
  provider_task_id text,
  status capere.provider_task_status NOT NULL DEFAULT 'submitted',
  request jsonb NOT NULL,
  result jsonb,
  cost_micro_usd bigint NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  next_poll_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, provider, task_type, request_fingerprint),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, integration_id)
    REFERENCES capere.integrations (organization_id, id) ON DELETE CASCADE
);
ALTER TABLE capere.technical_audits ADD CONSTRAINT technical_audits_provider_task_fkey
  FOREIGN KEY (organization_id, provider_task_id)
  REFERENCES capere.provider_tasks (organization_id, id);

CREATE TABLE capere.github_installations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES capere.organizations(id) ON DELETE CASCADE,
  integration_id uuid NOT NULL,
  installation_id bigint NOT NULL,
  account_login text NOT NULL,
  account_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, installation_id),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, integration_id)
    REFERENCES capere.integrations (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE capere.github_repositories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES capere.organizations(id) ON DELETE CASCADE,
  installation_id uuid NOT NULL,
  repository_id bigint NOT NULL,
  owner text NOT NULL,
  name text NOT NULL,
  default_branch text NOT NULL,
  private boolean NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  analyzed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, repository_id),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, installation_id)
    REFERENCES capere.github_installations (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE capere.github_change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES capere.organizations(id) ON DELETE CASCADE,
  repository_id uuid NOT NULL,
  status capere.change_request_status NOT NULL DEFAULT 'draft',
  title text NOT NULL,
  description text,
  base_sha text NOT NULL,
  changes jsonb NOT NULL,
  approved_by uuid REFERENCES capere.users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  branch_name text,
  pull_request_number integer,
  pull_request_url text,
  error text,
  created_by uuid REFERENCES capere.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, repository_id)
    REFERENCES capere.github_repositories (organization_id, id) ON DELETE CASCADE
);

ALTER TABLE capere.webhook_logs
  ADD COLUMN provider_event_id text,
  ADD COLUMN payload_hash text,
  ADD COLUMN received_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX webhook_logs_provider_event_unique
  ON capere.webhook_logs (provider, provider_event_id) WHERE provider_event_id IS NOT NULL;
CREATE UNIQUE INDEX webhook_logs_payload_hash_unique
  ON capere.webhook_logs (provider, payload_hash) WHERE provider_event_id IS NULL;

CREATE INDEX idx_sync_states_due ON capere.integration_sync_states (status, last_succeeded_at);
CREATE INDEX idx_provider_tasks_poll ON capere.provider_tasks (status, next_poll_at);
CREATE INDEX idx_keyword_rankings_date ON capere.keyword_rankings (organization_id, checked_on DESC);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'integration_authorizations','oauth_states','integration_sync_states','analytics_daily',
    'gbp_reviews','seo_projects','keywords','keyword_rankings','competitors','technical_audits',
    'provider_tasks','github_installations','github_repositories','github_change_requests'
  ] LOOP
    EXECUTE format('ALTER TABLE capere.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE capere.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON capere.%I FOR ALL TO authenticated USING (capere.is_org_member(organization_id)) WITH CHECK (capere.is_org_member(organization_id))',
      table_name || '_tenant_all', table_name
    );
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON capere.%I FOR EACH ROW EXECUTE FUNCTION capere.set_updated_at()',
      'trg_' || table_name || '_updated_at', table_name
    );
  END LOOP;
END $$;

-- Immutable fact tables do not have updated_at columns.
DROP TRIGGER trg_keyword_rankings_updated_at ON capere.keyword_rankings;
DROP TRIGGER trg_oauth_states_updated_at ON capere.oauth_states;
