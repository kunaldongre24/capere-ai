#!/usr/bin/env bash
set -euo pipefail

: "${SOURCE_DATABASE_URL:?Set SOURCE_DATABASE_URL to the current PostgreSQL connection string}"
: "${TARGET_DATABASE_URL:?Set TARGET_DATABASE_URL to the Cloud SQL PostgreSQL connection string}"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
DUMP_FILE="$WORK_DIR/capere.dump"
AUTH_USERS_FILE="$WORK_DIR/auth-users.tsv"

pg_dump "$SOURCE_DATABASE_URL" \
  --format=custom \
  --no-owner \
  --no-acl \
  --schema=capere \
  --file="$DUMP_FILE"

psql "$SOURCE_DATABASE_URL" -At -F $'\t' -c "select id,email,created_at from auth.users order by id" > "$AUTH_USERS_FILE"

psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS auth;
DO $$ BEGIN
  CREATE ROLE authenticated NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE ROLE service_role LOGIN BYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(COALESCE(current_setting('request.jwt.claim.sub', true), (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid
$$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;
SQL

psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 -c "truncate auth.users cascade"
psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 -c "copy auth.users(id,email,created_at) from stdin" < "$AUTH_USERS_FILE"

pg_restore \
  --dbname="$TARGET_DATABASE_URL" \
  --no-owner \
  --no-acl \
  --clean \
  --if-exists \
  "$DUMP_FILE"

psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
GRANT USAGE ON SCHEMA capere, auth TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA capere TO authenticated, service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA capere TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth.users TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA capere GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA capere GRANT USAGE, SELECT ON SEQUENCES TO authenticated, service_role;
SQL

SOURCE_ORGS="$(psql "$SOURCE_DATABASE_URL" -Atc 'select count(*) from capere.organizations')"
TARGET_ORGS="$(psql "$TARGET_DATABASE_URL" -Atc 'select count(*) from capere.organizations')"
SOURCE_USERS="$(psql "$SOURCE_DATABASE_URL" -Atc 'select count(*) from capere.users')"
TARGET_USERS="$(psql "$TARGET_DATABASE_URL" -Atc 'select count(*) from capere.users')"
if [[ "$SOURCE_ORGS" != "$TARGET_ORGS" || "$SOURCE_USERS" != "$TARGET_USERS" ]]; then
  echo "Migration validation failed: organizations $SOURCE_ORGS/$TARGET_ORGS, users $SOURCE_USERS/$TARGET_USERS" >&2
  exit 1
fi

echo "Database migration completed. Run the RLS and integration test suites before cutover."
