# ADR-0002: Kysely and hand-written SQL migrations over an ORM

- **Status:** Accepted
- **Date:** 2026-08-03
- **Phase:** 1

## Context

Capere AI is multi-tenant: every CPA firm is an organization, and a cross-tenant data leak is the single worst failure this system could have. The isolation model is PostgreSQL Row-Level Security, built on a security-definer `is_org_member(uuid)` helper, applied to every tenant-scoped table.

The database is hosted Supabase. That means the schema is not exclusively ours: `auth.users`, the `authenticated` and `service_role` roles, grants, and Supabase's own schemas are defined outside the application. Our migrations have to coexist with objects we do not own.

We also need to precompute analytics for Looker Studio rather than query transactional tables directly, which implies materialized views and non-trivial SQL later.

## Decision

Use **hand-written, versioned SQL migrations** in `supabase/migrations/` as the single source of truth for schema, and **Kysely 0.27** as a typed query builder. Generate TypeScript types _from_ the live database with `kysely-codegen`.

## Rationale

- **RLS policies, security-definer functions, triggers and grants are the security model, not an afterthought.** In hand-written SQL they are first-class objects reviewed in the same diff as the table they protect. In an ORM they are escape hatches bolted onto a schema DSL that does not model them.
- **Types are generated from the deployed database, not the other way round.** The database is the authority, so generated types cannot silently drift from what is actually running — which is the failure mode when a TS schema file and the live database disagree.
- **Kysely is a query builder, not an ORM.** No entity layer, no identity map, no lazy loading, no implicit N+1. Queries compile to predictable SQL, which matters because RLS makes query plans and predicate placement security-relevant, not merely a performance concern.
- **No pooler surprises.** Supabase sits behind pgbouncer in transaction mode. Kysely over `pg` uses plain parameterized statements and holds no session-level state we did not ask for — important because our `withUserContext` helper deliberately sets transaction-local state (`SET LOCAL ROLE`, `set_config(..., true)`) and needs it scoped to exactly one transaction.
- **The two-client model is explicit.** A service client that bypasses RLS for workers, and a user-scoped client that runs inside a transaction with JWT claims set so `auth.uid()` resolves. Expressing this with raw connection control is straightforward; through an ORM's connection abstraction it is fragile.

## Alternatives considered

**Prisma.** The best developer experience and migration tooling in the ecosystem, and the most widely known. Rejected because RLS is the core of our security model and Prisma has no first-class representation for policies, so they would live in `migration.sql` escape hatches while `schema.prisma` — the file engineers actually read — would not show them. Setting per-transaction JWT claims requires `$executeRaw` inside interactive transactions, and Prisma's connection handling behind pgbouncer needs specific care. Its schema file also wants to own tables it does not own on Supabase.

**Drizzle ORM.** The closest call. TypeScript-first, SQL-like, lightweight, with a genuine RLS story in recent versions. Rejected because Drizzle wants to own schema definition in TypeScript, which is in direct tension with Supabase, where `auth.users`, roles and grants are defined outside the app. That forces either duplicating external objects in the TS schema or accepting a permanent drift between `drizzle-kit` state and reality. Its migration tooling is also younger than the security-critical surface we are relying on.

**Raw `pg` with no query builder.** Maximum control, zero abstraction. Rejected because it gives up compile-time safety on column names and result shapes across a schema this size, and hand-written SQL string concatenation is where injection bugs are born.

## Consequences

**Positive.** Policies and schema are reviewed together in one diff; generated types track the real database; SQL is predictable and tunable; materialized views for Looker Studio are natural; migrations target the same hosted Supabase PostgreSQL platform used by every environment.

**Negative.** Migrations are written by hand — more work per change and no auto-diffing. Types must be regenerated (`pnpm db:types`) after a schema change, and a stale run means stale types. There is no built-in relation loading, so joins are written explicitly.

**Mitigation.** The RLS integration test — asserting that a member of org A cannot read, update or delete org B's rows across every tenant table — is the backstop that makes hand-written policies trustworthy. It is the highest-value test in the codebase and must never be allowed to regress. Type regeneration runs in CI, and a diff in generated output fails the build.
