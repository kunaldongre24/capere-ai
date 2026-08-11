-- A GHL location is itself a tenant boundary. Older versions allowed the same
-- external location to remain mapped to multiple Capere organizations, which
-- made SSO tenant resolution ambiguous. Keep the live mapping (or newest one
-- when none is live), remove only obsolete integration mappings, and enforce
-- global uniqueness going forward. Organizations and domain-event history are
-- deliberately untouched.

WITH ranked AS (
  SELECT
    l.id,
    row_number() OVER (
      PARTITION BY l.ghl_location_id
      ORDER BY
        EXISTS (
          SELECT 1
          FROM capere.integrations i
          WHERE i.organization_id = l.organization_id
            AND i.ghl_location_id = l.id
            AND i.provider = 'go_high_level'
            AND i.status = 'connected'
        ) DESC,
        l.created_at DESC,
        l.id DESC
    ) AS mapping_rank
  FROM capere.ghl_locations l
)
DELETE FROM capere.ghl_locations l
USING ranked r
WHERE l.id = r.id
  AND r.mapping_rank > 1;

CREATE UNIQUE INDEX uq_ghl_locations_external_location
  ON capere.ghl_locations (ghl_location_id);
