-- ===========================================================================
-- 0002_integrations.sql
--
-- Integration credentials and the GHL location reference.
--
-- Credential SECURITY: secrets are encrypted at rest by the application layer
-- (AES-256-GCM, see shared/crypto) and stored here as opaque bytea. The
-- database never sees a plaintext access token. RLS ensures only members of the
-- owning organization can read even the ciphertext.
-- ===========================================================================

CREATE TYPE capere.integration_provider AS ENUM (
  'go_high_level',
  'google_analytics_4',
  'google_search_console',
  'google_business_profile',
  'data_for_seo',
  'github'
);

CREATE TYPE capere.integration_status AS ENUM (
  'disconnected',
  'connecting',
  'connected',
  'error',
  'revoked'
);

CREATE TYPE capere.integration_scope AS ENUM (
  'read',
  'write',
  'read_write'
);

-- --- integrations ----------------------------------------------------------
CREATE TABLE capere.integrations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL REFERENCES capere.organizations(id) ON DELETE CASCADE,
  ghl_location_id        uuid REFERENCES capere.ghl_locations(id) ON DELETE CASCADE,
  provider               capere.integration_provider NOT NULL,
  account_id             text,
  account_name           text,
  status                 capere.integration_status NOT NULL DEFAULT 'disconnected',
  -- AES-256-GCM envelope: [version(1) | iv(12) | authTag(16) | ciphertext]
  encrypted_credentials  bytea,
  key_version            integer NOT NULL DEFAULT 1,
  -- OAuth / token metadata. `refresh_token` lives inside encrypted_credentials.
  scopes                 capere.integration_scope NOT NULL DEFAULT 'read',
  token_type             text,
  expires_at             timestamptz,
  last_sync_at           timestamptz,
  last_error             text,
  provider_metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, provider, ghl_location_id)
);

CREATE INDEX idx_integrations_org      ON capere.integrations (organization_id);
CREATE INDEX idx_integrations_org_hl   ON capere.integrations (ghl_location_id);
CREATE INDEX idx_integrations_provider ON capere.integrations (provider);

COMMENT ON TABLE capere.integrations IS
  'Per-provider connections. Access tokens are stored encrypted (AES-256-GCM envelope) and never logged.';

-- --- api_keys --------------------------------------------------------------
-- For machine clients (Open WebUI is the first). Only a salted hash is stored,
-- so a leaked database cannot be replayed as keys. The raw key is shown exactly
-- once at creation.
CREATE TABLE capere.api_keys (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid REFERENCES capere.organizations(id) ON DELETE CASCADE,
  name              text NOT NULL,
  -- First 8 characters of the raw key: shown in listings so the key can be
  -- recognized without revealing it.
  key_prefix        text NOT NULL,
  -- HMAC-SHA256 of the raw key with a per-install salt. Never the raw key.
  key_hash          text NOT NULL UNIQUE,
  -- Roles this key may assume. Defaults to the issuing user's effective role.
  roles             capere.org_role[] NOT NULL DEFAULT ARRAY['office_manager']::capere.org_role[],
  -- Optional scoping to a single GHL location.
  ghl_location_id   uuid REFERENCES capere.ghl_locations(id) ON DELETE CASCADE,
  expires_at        timestamptz,
  revoked_at        timestamptz,
  last_used_at      timestamptz,
  created_by        uuid REFERENCES capere.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_api_keys_org ON capere.api_keys (organization_id);

COMMENT ON TABLE capere.api_keys IS
  'Hashed machine/API keys. Only the HMAC hash and a lookup prefix are stored.';

-- --- RLS -------------------------------------------------------------------
ALTER TABLE capere.integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE capere.integrations FORCE ROW LEVEL SECURITY;
ALTER TABLE capere.api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE capere.api_keys FORCE ROW LEVEL SECURITY;

CREATE POLICY integrations_all ON capere.integrations
  FOR ALL TO authenticated
  USING (capere.is_org_member(organization_id))
  WITH CHECK (capere.is_org_member(organization_id));

CREATE POLICY api_keys_all ON capere.api_keys
  FOR ALL TO authenticated
  USING (capere.is_org_member(organization_id))
  WITH CHECK (capere.is_org_member(organization_id));

-- --- updated_at triggers ---------------------------------------------------
CREATE TRIGGER trg_integrations_updated_at
  BEFORE UPDATE ON capere.integrations
  FOR EACH ROW EXECUTE FUNCTION capere.set_updated_at();

CREATE TRIGGER trg_api_keys_updated_at
  BEFORE UPDATE ON capere.api_keys
  FOR EACH ROW EXECUTE FUNCTION capere.set_updated_at();
