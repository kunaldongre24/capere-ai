-- Phase 3 integration lifecycle foundation.
-- PostgreSQL UNIQUE treats NULL values as distinct, so the original constraint
-- allowed unlimited duplicate organization/provider rows when no GHL location
-- was attached. NULLS NOT DISTINCT gives the intended identity semantics.

ALTER TABLE capere.integrations
  DROP CONSTRAINT integrations_organization_id_provider_ghl_location_id_key;

ALTER TABLE capere.integrations
  ADD CONSTRAINT integrations_org_provider_location_key
  UNIQUE NULLS NOT DISTINCT (organization_id, provider, ghl_location_id);
