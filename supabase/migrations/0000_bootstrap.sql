-- ===========================================================================
-- 0000_bootstrap.sql
--
-- Makes one migration set apply cleanly to BOTH hosted Supabase and a plain
-- local Postgres.
--
-- Hosted Supabase already provides `auth.users`, `auth.uid()`, `auth.jwt()`,
-- and the anon/authenticated/service_role roles — AND it denies write access to
-- the `auth` schema even for the `postgres` role. So this migration cannot
-- blindly `CREATE ... IF NOT EXISTS` there: the CREATE is refused before the
-- IF NOT EXISTS is ever evaluated.
--
-- Instead, every `auth` object is created ONLY when it is genuinely absent, and
-- the whole block is wrapped so a permission error degrades to a notice. On
-- Supabase this is a complete no-op; on local Postgres it builds a faithful
-- shim with identical semantics.
--
-- This is what makes the identical migration set verifiable offline.
-- ===========================================================================

-- --- Extensions ------------------------------------------------------------
-- Supabase installs extensions into the `extensions` schema, which is already
-- on the search_path. Guarded because CREATE EXTENSION may be denied.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
EXCEPTION WHEN insufficient_privilege OR duplicate_object THEN
  RAISE NOTICE 'pgcrypto: already present or not permitted — continuing.';
END
$$;

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS citext;
EXCEPTION WHEN insufficient_privilege OR duplicate_object THEN
  RAISE NOTICE 'citext: already present or not permitted — continuing.';
END
$$;

-- --- Roles -----------------------------------------------------------------
-- Supabase provides these; locally we create them so GRANTs and SET LOCAL ROLE
-- behave identically. NOLOGIN: they are privilege sets, not login accounts.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Role creation not permitted — assuming Supabase provides them.';
END
$$;

-- --- auth schema shim (local Postgres only) --------------------------------
-- Each object is created only if absent. On Supabase all three exist, so the
-- guards short-circuit and nothing is attempted against the locked-down schema.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') THEN
    CREATE SCHEMA auth;
  END IF;

  -- Minimal stand-in for Supabase's auth.users: only the columns Capere reads.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'auth' AND c.relname = 'users'
  ) THEN
    CREATE TABLE auth.users (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email      text UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  END IF;

  -- auth.uid() — the identity of the current request.
  --
  -- Mirrors Supabase's implementation: it reads the `sub` claim from the
  -- transaction-local `request.jwt.claims` GUC. `withUserContext` sets that
  -- with set_config(..., true), so it is scoped to a single transaction and
  -- cannot leak across pooled connections.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'auth' AND p.proname = 'uid'
  ) THEN
    EXECUTE $fn$
      CREATE FUNCTION auth.uid() RETURNS uuid
      LANGUAGE sql STABLE
      AS $body$
        SELECT NULLIF(
          COALESCE(
            current_setting('request.jwt.claim.sub', true),
            (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
          ),
          ''
        )::uuid
      $body$
    $fn$;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'auth' AND p.proname = 'jwt'
  ) THEN
    EXECUTE $fn$
      CREATE FUNCTION auth.jwt() RETURNS jsonb
      LANGUAGE sql STABLE
      AS $body$
        SELECT COALESCE(
          NULLIF(current_setting('request.jwt.claims', true), '')::jsonb,
          '{}'::jsonb
        )
      $body$
    $fn$;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'auth schema is managed by Supabase — skipping shim.';
END
$$;

-- --- Application schema ----------------------------------------------------
-- Capere's objects live in `capere`, never `public`, so they cannot collide
-- with Supabase-managed objects and can be dropped wholesale in tests.
CREATE SCHEMA IF NOT EXISTS capere;

GRANT USAGE ON SCHEMA capere TO anon, authenticated, service_role;

-- Tables created later in `capere` are reachable by `authenticated` (still
-- gated by RLS) and unrestricted for `service_role`.
ALTER DEFAULT PRIVILEGES IN SCHEMA capere
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA capere
  GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA capere
  GRANT USAGE, SELECT ON SEQUENCES TO authenticated, service_role;

-- --- Shared helpers --------------------------------------------------------

-- Keeps `updated_at` honest without every service remembering to set it.
CREATE OR REPLACE FUNCTION capere.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

COMMENT ON SCHEMA capere IS
  'Capere AI application schema. Intelligence layer over GoHighLevel; never duplicates CRM entities.';
