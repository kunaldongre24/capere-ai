-- ===========================================================================
-- 0005_composite_tenant_fks.sql
--
-- Closes a cross-tenant integrity hole found by an adversarial audit of the
-- Phase 1 foundation.
--
-- THE BUG: child tables carry their own `organization_id` AND a single-column
-- foreign key to a parent, with nothing forcing the two to agree. RLS checks
-- only `is_org_member(organization_id)`, and the FK checks only that the parent
-- row exists — not that it belongs to the same tenant.
--
-- THE ATTACK (conversation_messages, which also has UNIQUE (session_id, sequence)):
--   A member of org A, inside a normal RLS-scoped transaction, inserts
--     (session_id = <org B's session>, organization_id = <org A>, sequence = 5)
--   WITH CHECK passes: the row is stamped with org A, and they are a member.
--   The FK passes: org B's session genuinely exists.
--   The row is invisible to org B under RLS — yet it permanently occupies the
--   slot (orgB_session, 5) in the unique index. Org B's next legitimate write
--   at sequence 5 fails with a unique violation caused by a row they cannot
--   see, select, or delete. A cross-tenant write denial that is undiagnosable
--   from the victim's side.
--
-- THE FIX: give each parent a UNIQUE (organization_id, id) and make children
-- reference the composite key. The database then enforces that parent and child
-- share a tenant — no application discipline required.
--
-- `id` is already the primary key, so UNIQUE (organization_id, id) is redundant
-- for uniqueness. It exists solely to be a valid FK target.
-- ===========================================================================

-- --- Parent composite unique keys ------------------------------------------
ALTER TABLE capere.ai_sessions
  ADD CONSTRAINT ai_sessions_org_id_key UNIQUE (organization_id, id);

ALTER TABLE capere.ghl_locations
  ADD CONSTRAINT ghl_locations_org_id_key UNIQUE (organization_id, id);

ALTER TABLE capere.domain_events
  ADD CONSTRAINT domain_events_org_id_key UNIQUE (organization_id, id);

ALTER TABLE capere.ai_budgets
  ADD CONSTRAINT ai_budgets_org_id_key UNIQUE (organization_id, id);

ALTER TABLE capere.scheduled_jobs
  ADD CONSTRAINT scheduled_jobs_org_id_key UNIQUE (organization_id, id);

-- --- conversation_messages -> ai_sessions ----------------------------------
-- The highest-impact case: this table holds actual AI transcript content.
ALTER TABLE capere.conversation_messages
  DROP CONSTRAINT conversation_messages_session_id_fkey;

ALTER TABLE capere.conversation_messages
  ADD CONSTRAINT conversation_messages_session_fkey
  FOREIGN KEY (organization_id, session_id)
  REFERENCES capere.ai_sessions (organization_id, id)
  ON DELETE CASCADE;

-- --- ai_usage_events -> ai_sessions ---------------------------------------
-- Nullable: system-initiated calls have no session. A composite FK still
-- constrains the pair when session_id IS NOT NULL (MATCH SIMPLE semantics mean
-- the constraint is skipped entirely when any column is NULL, which is what we
-- want here since organization_id is NOT NULL and session_id is nullable).
ALTER TABLE capere.ai_usage_events
  DROP CONSTRAINT ai_usage_events_session_id_fkey;

ALTER TABLE capere.ai_usage_events
  ADD CONSTRAINT ai_usage_events_session_fkey
  FOREIGN KEY (organization_id, session_id)
  REFERENCES capere.ai_sessions (organization_id, id)
  ON DELETE SET NULL;

-- --- integrations -> ghl_locations ----------------------------------------
ALTER TABLE capere.integrations
  DROP CONSTRAINT integrations_ghl_location_id_fkey;

ALTER TABLE capere.integrations
  ADD CONSTRAINT integrations_ghl_location_fkey
  FOREIGN KEY (organization_id, ghl_location_id)
  REFERENCES capere.ghl_locations (organization_id, id)
  ON DELETE CASCADE;

-- --- api_keys -> ghl_locations -------------------------------------------
-- api_keys.organization_id is nullable, so the composite FK is skipped when it
-- is NULL — acceptable, because such a key is rejected at verification time.
ALTER TABLE capere.api_keys
  DROP CONSTRAINT api_keys_ghl_location_id_fkey;

ALTER TABLE capere.api_keys
  ADD CONSTRAINT api_keys_ghl_location_fkey
  FOREIGN KEY (organization_id, ghl_location_id)
  REFERENCES capere.ghl_locations (organization_id, id)
  ON DELETE CASCADE;

-- --- insights -> domain_events -------------------------------------------
ALTER TABLE capere.insights
  DROP CONSTRAINT insights_source_event_id_fkey;

ALTER TABLE capere.insights
  ADD CONSTRAINT insights_source_event_fkey
  FOREIGN KEY (organization_id, source_event_id)
  REFERENCES capere.domain_events (organization_id, id)
  ON DELETE SET NULL;

-- --- ai_budget_alerts -> ai_budgets --------------------------------------
ALTER TABLE capere.ai_budget_alerts
  DROP CONSTRAINT ai_budget_alerts_budget_id_fkey;

ALTER TABLE capere.ai_budget_alerts
  ADD CONSTRAINT ai_budget_alerts_budget_fkey
  FOREIGN KEY (organization_id, budget_id)
  REFERENCES capere.ai_budgets (organization_id, id)
  ON DELETE CASCADE;

-- --- job_runs -> scheduled_jobs ------------------------------------------
ALTER TABLE capere.job_runs
  DROP CONSTRAINT job_runs_scheduled_job_id_fkey;

ALTER TABLE capere.job_runs
  ADD CONSTRAINT job_runs_scheduled_job_fkey
  FOREIGN KEY (organization_id, scheduled_job_id)
  REFERENCES capere.scheduled_jobs (organization_id, id)
  ON DELETE CASCADE;

COMMENT ON CONSTRAINT conversation_messages_session_fkey ON capere.conversation_messages IS
  'Composite FK: guarantees a message and its session belong to the same organization. '
  'A single-column FK would allow a tenant to attach rows to another tenant''s session.';
