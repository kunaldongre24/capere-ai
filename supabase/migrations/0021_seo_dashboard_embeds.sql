ALTER TABLE capere.api_keys
  ADD COLUMN purpose text NOT NULL DEFAULT 'general';

CREATE INDEX idx_api_keys_dashboard_embeds
  ON capere.api_keys (organization_id, purpose, ghl_location_id)
  WHERE revoked_at IS NULL;

COMMENT ON COLUMN capere.api_keys.purpose IS
  'Credential purpose. seo_dashboard keys may only bootstrap read-only GHL dashboard embeds.';
