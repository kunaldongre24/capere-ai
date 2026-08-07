# ADR-0003: Supabase as the Postgres and Auth provider

- **Status:** Accepted
- **Date:** 2026-08-03
- **Phase:** 1

## Context

Capere needs a Postgres database, user authentication, and file storage. It is a small team building a commercial SaaS product for CPA firms, where the tenancy boundary is security-critical and a cross-tenant leak would be an existential problem.

Two things follow from that. First, authentication is not a differentiator worth building — password reset flows, email verification, session refresh and MFA are solved problems where a bug is a breach. Second, whatever we choose has to make Row-Level Security a first-class citizen, because RLS is the database half of our isolation model.

## Decision

Use **hosted Supabase** for Postgres, Auth and Storage. Connect via the **session-mode pooler** (port 5432), not the transaction pooler (6543).

## Rationale

- **Auth is delegated to a provider whose entire job it is.** Supabase Auth handles signup, email verification, password reset, refresh tokens and MFA. Capere verifies the resulting JWT and resolves membership from its own tables — a narrow, testable surface.
- **RLS is native and idiomatic.** Supabase's whole access model is built on `auth.uid()` and policies, so our security-definer helpers and per-table policies are the intended way to use the platform rather than a fight against it.
- **It is Postgres, not a Postgres-like thing.** Migrations are plain SQL, extensions are available, and materialized views for Looker Studio work normally. No dialect surprises.
- **Auth and application data share one database.** Membership resolution is a local join, not a cross-service call, which keeps the request path short and transactional.
- **Verified empirically before committing.** Against the live project (Postgres 17.6) we confirmed `auth.uid()` resolves from transaction-local `request.jwt.claims`, `SET LOCAL ROLE authenticated` works, and the connecting role has `BYPASSRLS` — so the two-client model in ADR-0002 is sound on this platform rather than assumed.

## Alternatives considered

**Self-hosted Postgres + a separate auth provider (Auth0, Clerk).** More control, no vendor coupling in the database. Rejected: auth data then lives outside the database, so every membership check becomes a network call or a cache with its own staleness bugs. It also means operating Postgres — backups, upgrades, HA — which is real work for a small team and buys nothing Phase 1 needs.

**Self-hosted Postgres + hand-rolled auth.** Cheapest in dollars. Rejected outright: password hashing, reset-token expiry, session invalidation and refresh rotation are exactly where security bugs hide, and a mistake here is a breach rather than an inconvenience.

**Firebase / Firestore.** Excellent auth. Rejected because the data model is wrong for this product: we need relational joins, SQL aggregation for analytics, materialized views for Looker Studio, and RLS. A document store fights all four.

**AWS RDS + Cognito.** Production-grade and scalable. Rejected for Phase 1 as disproportionate operational overhead — VPCs, security groups, Cognito's notoriously awkward developer experience — for a product that has no customers yet.

## Consequences

**Positive.** Auth, database and storage from one provider with one bill. RLS works as designed. Standard Postgres means no dialect lock-in at the SQL level. Migrations are portable, which is what lets the same files target a local container for offline development.

**Negative.**

- **Vendor coupling is real but bounded.** `auth.users`, `auth.uid()` and the `authenticated`/`service_role` roles are Supabase constructs. Migration `0000_bootstrap.sql` shims all of them for plain Postgres, so the coupling is one file rather than a scattered assumption — but it is coupling.
- **Pooler mode matters and is easy to get wrong.** The transaction pooler (6543) breaks `SET LOCAL ROLE` and some DDL, which would silently break both migrations and the RLS mechanism. `.env.example` documents session mode explicitly.
- **The `auth` schema is not writable.** Even the `postgres` role is denied `CREATE` there, which is why `0000_bootstrap.sql` detects existing objects rather than using `CREATE ... IF NOT EXISTS` — the CREATE is refused before the guard is evaluated.
- **TLS is currently encrypted but unverified.** `resolveSsl()` sets `rejectUnauthorized: false` because the pooler presents a certificate signed by Supabase's own CA. This is the documented default for Supabase clients, and it is MITM-able. Tracked as a `TODO(security)` in `shared/database/ssl.ts`; pin the CA before production.
- **Test runs currently target the live project.** Acceptable while there are no customers, and `test/setup.ts` refuses any destructive reset against a non-localhost host — but a separate test project is the right end state.
