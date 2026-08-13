#!/usr/bin/env bash
set -euo pipefail

: "${SOURCE_DATABASE_URL:?Set SOURCE_DATABASE_URL to the current PostgreSQL connection string}"
: "${TARGET_DATABASE_URL:?Set TARGET_DATABASE_URL to the Cloud SQL PostgreSQL connection string}"
: "${SERVICE_ROLE_PASSWORD:?Set SERVICE_ROLE_PASSWORD to the generated Cloud SQL application password}"

if [[ ! "$SERVICE_ROLE_PASSWORD" =~ ^[A-Za-z0-9_-]{32,128}$ ]]; then
  echo "SERVICE_ROLE_PASSWORD must contain 32-128 URL-safe characters" >&2
  exit 1
fi

PG_BIN="${PG_BIN:-}"
if [[ -z "$PG_BIN" && -x /usr/lib/postgresql/17/bin/pg_dump ]]; then
  PG_BIN=/usr/lib/postgresql/17/bin
fi
PG_DUMP="${PG_BIN:+$PG_BIN/}pg_dump"
PG_RESTORE="${PG_BIN:+$PG_BIN/}pg_restore"
PSQL="${PG_BIN:+$PG_BIN/}psql"

for tool in "$PG_DUMP" "$PG_RESTORE" "$PSQL"; do
  command -v "$tool" >/dev/null || {
    echo "PostgreSQL client tool not found: $tool" >&2
    exit 1
  }
done

PG_DUMP_MAJOR="$($PG_DUMP --version | sed -E 's/.* ([0-9]+)(\..*)?$/\1/')"
if (( PG_DUMP_MAJOR < 17 )); then
  echo "PostgreSQL 17+ client tools are required; found pg_dump $PG_DUMP_MAJOR" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
DUMP_FILE="$WORK_DIR/capere.dump"
AUTH_USERS_FILE="$WORK_DIR/auth-users.tsv"
SOURCE_SCHEMA_FILE="$WORK_DIR/source-schema.sql"
TARGET_SCHEMA_FILE="$WORK_DIR/target-schema.sql"

"$PG_DUMP" "$SOURCE_DATABASE_URL" \
  --format=custom \
  --no-owner \
  --no-acl \
  --schema=capere \
  --file="$DUMP_FILE"

"$PSQL" "$SOURCE_DATABASE_URL" -At -F $'\t' -c \
  "select id,email,coalesce(created_at, now()) from auth.users order by id" > "$AUTH_USERS_FILE"

"$PSQL" "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
ALTER EXTENSION pgcrypto SET SCHEMA extensions;
ALTER EXTENSION "uuid-ossp" SET SCHEMA extensions;
ALTER EXTENSION vector SET SCHEMA extensions;
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

"$PSQL" "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c "ALTER ROLE service_role PASSWORD '$SERVICE_ROLE_PASSWORD'"

"$PSQL" "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 -c "truncate auth.users cascade"
"$PSQL" "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 -c "copy auth.users(id,email,created_at) from stdin" < "$AUTH_USERS_FILE"

"$PG_RESTORE" \
  --dbname="$TARGET_DATABASE_URL" \
  --no-owner \
  --no-acl \
  --clean \
  --if-exists \
  --exit-on-error \
  "$DUMP_FILE"

"$PSQL" "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
GRANT USAGE ON SCHEMA capere, auth TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA capere TO authenticated, service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA capere TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth.users TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA capere GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA capere GRANT USAGE, SELECT ON SEQUENCES TO authenticated, service_role;
SQL

SOURCE_ORGS="$("$PSQL" "$SOURCE_DATABASE_URL" -Atc 'select count(*) from capere.organizations')"
TARGET_ORGS="$("$PSQL" "$TARGET_DATABASE_URL" -qAtc 'set role service_role; select count(*) from capere.organizations')"
SOURCE_USERS="$("$PSQL" "$SOURCE_DATABASE_URL" -Atc 'select count(*) from capere.users')"
TARGET_USERS="$("$PSQL" "$TARGET_DATABASE_URL" -qAtc 'set role service_role; select count(*) from capere.users')"
if [[ "$SOURCE_ORGS" != "$TARGET_ORGS" || "$SOURCE_USERS" != "$TARGET_USERS" ]]; then
  echo "Migration validation failed: organizations $SOURCE_ORGS/$TARGET_ORGS, users $SOURCE_USERS/$TARGET_USERS" >&2
  exit 1
fi

SOURCE_COUNTS_FILE="$WORK_DIR/source-counts.tsv"
TARGET_COUNTS_FILE="$WORK_DIR/target-counts.tsv"
TABLES="$("$PSQL" "$SOURCE_DATABASE_URL" -Atc "select tablename from pg_tables where schemaname='capere' order by tablename")"
while IFS= read -r table; do
  [[ -n "$table" ]] || continue
  source_count="$("$PSQL" "$SOURCE_DATABASE_URL" -Atc "select count(*) from capere.\"$table\"")"
  target_count="$("$PSQL" "$TARGET_DATABASE_URL" -qAtc "set role service_role; select count(*) from capere.\"$table\"")"
  printf '%s\t%s\n' "$table" "$source_count" >> "$SOURCE_COUNTS_FILE"
  printf '%s\t%s\n' "$table" "$target_count" >> "$TARGET_COUNTS_FILE"
done <<< "$TABLES"
if ! diff -u "$SOURCE_COUNTS_FILE" "$TARGET_COUNTS_FILE"; then
  echo "Migration validation failed: exact per-table counts differ" >&2
  exit 1
fi
TARGET_TABLE_ROWS="$(awk '{ total += $2 } END { print total + 0 }' "$TARGET_COUNTS_FILE")"
SOURCE_RLS_TABLES="$("$PSQL" "$SOURCE_DATABASE_URL" -Atc "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='capere' and c.relkind='r' and c.relrowsecurity")"
TARGET_RLS_TABLES="$("$PSQL" "$TARGET_DATABASE_URL" -Atc "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='capere' and c.relkind='r' and c.relrowsecurity")"
SOURCE_POLICIES="$("$PSQL" "$SOURCE_DATABASE_URL" -Atc "select count(*) from pg_policies where schemaname='capere'")"
TARGET_POLICIES="$("$PSQL" "$TARGET_DATABASE_URL" -Atc "select count(*) from pg_policies where schemaname='capere'")"
if [[ "$SOURCE_RLS_TABLES" != "$TARGET_RLS_TABLES" || "$SOURCE_POLICIES" != "$TARGET_POLICIES" ]]; then
  echo "Migration validation failed: RLS tables $SOURCE_RLS_TABLES/$TARGET_RLS_TABLES, policies $SOURCE_POLICIES/$TARGET_POLICIES" >&2
  exit 1
fi

"$PG_DUMP" "$SOURCE_DATABASE_URL" --schema-only --no-owner --no-acl --schema=capere --file="$SOURCE_SCHEMA_FILE"
"$PG_DUMP" "$TARGET_DATABASE_URL" --schema-only --no-owner --no-acl --schema=capere --file="$TARGET_SCHEMA_FILE"
sed -i -e '/^\\restrict /d' -e '/^\\unrestrict /d' \
  -e '/^-- Dumped from database version /d' \
  -e '/^-- Dumped by pg_dump version /d' \
  "$SOURCE_SCHEMA_FILE" "$TARGET_SCHEMA_FILE"
if ! diff -u "$SOURCE_SCHEMA_FILE" "$TARGET_SCHEMA_FILE"; then
  echo "Migration validation failed: Capere schema objects differ" >&2
  exit 1
fi

echo "Database migration completed: organizations $TARGET_ORGS, users $TARGET_USERS, rows $TARGET_TABLE_ROWS, RLS tables $TARGET_RLS_TABLES, policies $TARGET_POLICIES."
