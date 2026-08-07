-- ===========================================================================
-- 0001_core_tenancy.sql
--
-- Organizations, users, membership, and the RLS foundation every other table
-- builds on.
--
-- Tenancy model: an organization is a CPA firm. Every tenant-scoped table
-- carries `organization_id` and is protected by policies built on the
-- security-definer helper `capere.is_org_member()`.
--
-- RLS is the BACKSTOP, not the mechanism. Services still scope every query by
-- organization_id; these policies catch the query that forgets.
-- ===========================================================================

-- --- Enums -----------------------------------------------------------------
CREATE TYPE capere.org_role AS ENUM (
  'owner',
  'office_manager',
  'marketing_manager',
  'seo_specialist',
  'capere_admin'
);

CREATE TYPE capere.org_status AS ENUM ('active', 'suspended', 'cancelled');

-- --- organizations ---------------------------------------------------------
CREATE TABLE capere.organizations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL CHECK (length(trim(name)) > 0),
  -- `text` rather than `citext`: the extension is not guaranteed to be
  -- grantable on hosted Supabase, and the CHECK below gives the same
  -- case-insensitivity guarantee by forbidding non-lowercase values outright.
  slug          text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  status        capere.org_status NOT NULL DEFAULT 'active',
  -- Free-form settings; typed config belongs in dedicated columns/tables.
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE capere.organizations IS 'A CPA firm. The tenant boundary for all data in Capere.';

-- --- users -----------------------------------------------------------------
-- A profile mirror of auth.users. Supabase Auth owns identity and credentials;
-- this table holds only the application-level profile, keyed by the same id.
CREATE TABLE capere.users (
  id            uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Stored lowercase so equality comparisons are case-insensitive without
  -- citext. Application code normalizes before writing; the CHECK enforces it.
  email         text NOT NULL CHECK (email = lower(email)),
  full_name     text,
  avatar_url    text,
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE capere.users IS
  'Application profile mirroring auth.users. Supabase Auth remains the source of truth for identity.';

-- --- organization_members --------------------------------------------------
CREATE TABLE capere.organization_members (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES capere.organizations(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES capere.users(id) ON DELETE CASCADE,
  role              capere.org_role NOT NULL DEFAULT 'office_manager',
  invited_by        uuid REFERENCES capere.users(id) ON DELETE SET NULL,
  joined_at         timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);

CREATE INDEX idx_org_members_user ON capere.organization_members (user_id);
CREATE INDEX idx_org_members_org  ON capere.organization_members (organization_id);

COMMENT ON TABLE capere.organization_members IS
  'Maps Supabase auth users to organizations with a role. The basis of all access control.';

-- --- ghl_locations ---------------------------------------------------------
-- REFERENCES ONLY. GoHighLevel owns the CRM; Capere stores the pointer and
-- nothing more. Never mirror contacts, opportunities or conversations here.
CREATE TABLE capere.ghl_locations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES capere.organizations(id) ON DELETE CASCADE,
  ghl_location_id   text NOT NULL,
  name              text,
  timezone          text,
  is_primary        boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, ghl_location_id)
);

CREATE INDEX idx_ghl_locations_org ON capere.ghl_locations (organization_id);

COMMENT ON TABLE capere.ghl_locations IS
  'Reference to a GoHighLevel location. Pointer only — CRM entities are never duplicated into Capere.';

-- --- Membership helpers ----------------------------------------------------
--
-- SECURITY DEFINER is essential and deliberate: these functions are called from
-- within RLS policies on organization_members itself. Without DEFINER the
-- policy would re-enter the same table's RLS check and recurse infinitely.
--
-- `search_path` is pinned to defeat search-path hijacking, the standard attack
-- against SECURITY DEFINER functions.

CREATE OR REPLACE FUNCTION capere.is_org_member(target_org uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = capere, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM capere.organization_members m
    WHERE m.organization_id = target_org
      AND m.user_id = auth.uid()
  )
$$;

COMMENT ON FUNCTION capere.is_org_member(uuid) IS
  'True when the current JWT identity belongs to the given organization. SECURITY DEFINER to avoid RLS recursion.';

CREATE OR REPLACE FUNCTION capere.has_org_role(target_org uuid, allowed capere.org_role[])
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = capere, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM capere.organization_members m
    WHERE m.organization_id = target_org
      AND m.user_id = auth.uid()
      AND m.role = ANY(allowed)
  )
$$;

COMMENT ON FUNCTION capere.has_org_role(uuid, capere.org_role[]) IS
  'True when the current identity holds one of the given roles in the organization.';

-- Organizations the current identity can see. Used by policies on the
-- organizations table itself, where is_org_member would be circular.
CREATE OR REPLACE FUNCTION capere.current_user_org_ids()
RETURNS SETOF uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = capere, pg_temp
AS $$
  SELECT m.organization_id
  FROM capere.organization_members m
  WHERE m.user_id = auth.uid()
$$;

-- --- Row-Level Security ----------------------------------------------------
ALTER TABLE capere.organizations        ENABLE ROW LEVEL SECURITY;
ALTER TABLE capere.users                ENABLE ROW LEVEL SECURITY;
ALTER TABLE capere.organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE capere.ghl_locations        ENABLE ROW LEVEL SECURITY;

-- FORCE makes policies apply to the table owner too. Without this, the role
-- that owns the tables silently bypasses every policy — an easy way to believe
-- isolation works when it does not.
ALTER TABLE capere.organizations        FORCE ROW LEVEL SECURITY;
ALTER TABLE capere.users                FORCE ROW LEVEL SECURITY;
ALTER TABLE capere.organization_members FORCE ROW LEVEL SECURITY;
ALTER TABLE capere.ghl_locations        FORCE ROW LEVEL SECURITY;

-- organizations: visible only to members.
CREATE POLICY org_select_member ON capere.organizations
  FOR SELECT TO authenticated
  USING (id IN (SELECT capere.current_user_org_ids()));

-- Only owners and Capere admins may modify the organization record.
CREATE POLICY org_update_owner ON capere.organizations
  FOR UPDATE TO authenticated
  USING (capere.has_org_role(id, ARRAY['owner', 'capere_admin']::capere.org_role[]))
  WITH CHECK (capere.has_org_role(id, ARRAY['owner', 'capere_admin']::capere.org_role[]));

-- users: a user sees their own profile, plus profiles of people they share an
-- organization with (needed to render member lists).
CREATE POLICY users_select_self_or_coworker ON capere.users
  FOR SELECT TO authenticated
  USING (
    id = auth.uid()
    OR EXISTS (
      SELECT 1
      FROM capere.organization_members m
      WHERE m.user_id = capere.users.id
        AND m.organization_id IN (SELECT capere.current_user_org_ids())
    )
  );

CREATE POLICY users_update_self ON capere.users
  FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- organization_members: members see the roster of their own organizations.
CREATE POLICY org_members_select ON capere.organization_members
  FOR SELECT TO authenticated
  USING (organization_id IN (SELECT capere.current_user_org_ids()));

-- Only owners/admins manage membership.
CREATE POLICY org_members_write ON capere.organization_members
  FOR ALL TO authenticated
  USING (capere.has_org_role(organization_id, ARRAY['owner', 'capere_admin']::capere.org_role[]))
  WITH CHECK (capere.has_org_role(organization_id, ARRAY['owner', 'capere_admin']::capere.org_role[]));

-- ghl_locations: standard org-scoped access.
CREATE POLICY ghl_locations_all ON capere.ghl_locations
  FOR ALL TO authenticated
  USING (capere.is_org_member(organization_id))
  WITH CHECK (capere.is_org_member(organization_id));

-- --- updated_at triggers ---------------------------------------------------
CREATE TRIGGER trg_organizations_updated_at
  BEFORE UPDATE ON capere.organizations
  FOR EACH ROW EXECUTE FUNCTION capere.set_updated_at();

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON capere.users
  FOR EACH ROW EXECUTE FUNCTION capere.set_updated_at();

CREATE TRIGGER trg_org_members_updated_at
  BEFORE UPDATE ON capere.organization_members
  FOR EACH ROW EXECUTE FUNCTION capere.set_updated_at();

CREATE TRIGGER trg_ghl_locations_updated_at
  BEFORE UPDATE ON capere.ghl_locations
  FOR EACH ROW EXECUTE FUNCTION capere.set_updated_at();
