# Capere AI

**An AI Growth Operating System for CPA firms.**

Capere is the _intelligence layer_ that sits on top of GoHighLevel.

- **GoHighLevel owns the CRM** — contacts, opportunities, conversations, calendars, reviews, workflows, payments. Capere never duplicates these; it stores references (`ghl_location_id`, `ghl_contact_id`, …).
- **Capere owns the intelligence** — stateless application services, SEO and business analytics, insights, recommendations, content strategy and executive reporting.

Capere does not try to replace GoHighLevel. It makes it significantly smarter.

---

## Status: Phase 6 implemented

Capere uses stateless API and worker processes. Each request loads organization context and optional durable conversation history from PostgreSQL, retrieves knowledge from Supabase pgvector, executes bounded read-only tools, routes model calls through OpenRouter, and records token cost against the organization. Qdrant remains an optional adapter selected with `VECTOR_STORE_PROVIDER=qdrant`.

Verified against hosted Supabase PostgreSQL:

- **348 unit/integration tests passing**, plus **10 HTTP e2e tests**, including **175 row-level-security tests** asserting that no organization can read, update, delete or insert into another's data across every tenant table.
- Focused coverage includes API-key lifecycle, owner-only human sessions, organization-scoped machine sessions, concurrent transcript appends, fail-closed reflection, outbox claim recovery, and scheduler retries/dead-lettering.
- Optional sessions and tool transcripts are persisted, model parameters are propagated, and costs are recorded in exact integer micro-USD.

The backend foundations for Phases 1-6 are implemented: approval-first GHL task/workflow automation, model-routed content drafts, persisted daily briefs, scheduled execution, autonomous recommendation proposals, and job monitoring. Full GHL custom-menu deployment, Looker Studio assets, production UI configuration, and staging/live-provider validation remain deferred.

Open WebUI is deployed as a single-tenant interface: each instance uses one
organization-bound Capere API key. Deploy a separate isolated instance per CPA
firm until a verified Open WebUI user-identity bridge is introduced. Chat
attachments are not ingested automatically; knowledge documents use the
authenticated `/api/v1/rag/documents` endpoint.

---

## Architecture

```
GoHighLevel ──webhooks──▶ Capere API ──▶ Application Use Cases ──▶ Domain Services
                              │                    │                      │
                              ▼                    ▼                      ▼
                          Supabase             OpenRouter          Provider Adapters
                              │
                              ├──▶ Looker Studio (Phase 5)
                              └──▶ Open WebUI
```

**Intelligence is stateless and layered.** The runtime is split into explicit services:

| Module                | Responsibility                                                          |
| --------------------- | ----------------------------------------------------------------------- |
| `prompts/`            | Versioned templates, per-org overrides, checksum recorded on every call |
| `memory/`             | Facade over four layers: conversation, business, working, semantic      |
| `context/`            | Live organization state → rendered prompt block                         |
| `registry/`           | Enforces schema, permissions, timeout and telemetry for every tool      |
| `tools/`              | The `Tool` contract every capability implements                         |
| `execution/`          | Bounded read-only model/tool execution                                  |
| `review/`             | Optional response review for fabrication                                |
| application use cases | Coordinate one request without retaining process state                  |
| durable workflows     | BullMQ jobs for long-running and mutating operations                    |

Every architectural decision is recorded in [`docs/adr/`](docs/adr/README.md).

---

## Quick start

```bash
pnpm install
cp .env.example .env          # fill in Supabase + secrets
pnpm migrate                  # apply supabase/migrations/
pnpm api-key:issue <organization-id> "Open WebUI" office_manager
# Put the one-time raw value in .env as OPEN_WEBUI_API_KEY.
pnpm build
pnpm start                    # API on :3000
pnpm start:worker             # outbox relay + scheduler (separate process)
```

When changing vector providers, enqueue every active document for a clean
rebuild. Supply a deployment identifier to make retries of the same cutover
idempotent:

```bash
pnpm --filter @capere/backend rag:rebuild-vectors pgvector-2026-08-05
```

The command only queues durable ingestion jobs; the worker performs embedding
and indexing. Keep the worker running until the RAG job queue drains.

| Endpoint                    | Purpose                                                          |
| --------------------------- | ---------------------------------------------------------------- |
| `GET /health`               | Liveness — does not touch dependencies                           |
| `GET /health/ready`         | Readiness — 503 when a dependency is down                        |
| `GET /api/v1/docs`          | OpenAPI / Swagger UI                                             |
| `POST /v1/chat/completions` | OpenAI-compatible, for Open WebUI                                |
| `GET /v1/models`            | Advertises `capere-intelligence`; accepts legacy `capere-hermes` |

The chat endpoints are deliberately unversioned and un-enveloped — those paths and shapes are fixed by the OpenAI wire format that Open WebUI speaks. See ADR-0006.

## Tests

```bash
pnpm test          # full suite
pnpm typecheck
```

**`test/rls.spec.ts` is the most important file in the repository.** It seeds two organizations, puts a row in every tenant-scoped table for each, and asserts org A can never reach org B's. It includes a completeness meta-test that queries `pg_class` for every table carrying an `organization_id` column and fails if any lacks coverage — so a new table cannot be added without an isolation test.

If that suite regresses, tenant isolation is broken. It must never be skipped or weakened.

---

## Security model

**Two layers, deliberately.**

1. **Application layer** — every service scopes queries by `organization_id`; guards run in order: throttle → authenticate → resolve organization → check role → check feature flag.
2. **Database layer** — Postgres RLS on every tenant table, built on the security-definer helper `capere.is_org_member()`, with `FORCE ROW LEVEL SECURITY` so even the table owner is subject to policy.

RLS is the _backstop_, not the mechanism. It catches the query that forgets. A single missed `where` clause would otherwise be a cross-tenant breach.

**Two database clients.** A service client that bypasses RLS for workers and system jobs, and `withUserContext()`, which opens a transaction and sets `SET LOCAL ROLE authenticated` plus transaction-local JWT claims so `auth.uid()` resolves. Without the second, connecting directly to Postgres silently bypasses every policy — the most common way Supabase multi-tenancy leaks.

**Other measures.** AES-256-GCM envelope encryption with key versioning for integration credentials, AAD-bound to prevent a blob being moved between tenants. API keys stored as HMAC-SHA256 with a lookup prefix. Secret redaction in structured logs. Composite foreign keys so a child row cannot reference another tenant's parent.

---

## What is deliberately not here

Later product phases still include:

- Command centers, reporting, and recommendation automation.
- SEO Command Center and AI CMO menus (**Phase 5**)
- Looker Studio models (**Phase 5**)
- Recommendation engine (**Phase 5**)

Phase 3 sync and webhook events have concrete publishers.

### Known gaps

Stated plainly rather than left to be discovered:

- **Database TLS is verified in production** using `DATABASE_SSL_CA_BASE64`; development/test may omit it for local infrastructure.
- **Cron expressions are not parsed** — use the exact `hourly`/`daily`/`weekly`/`monthly` shorthands. Five-field cron expressions are rejected until a real parser is implemented, preventing accidental hourly execution.
- **`TEST_DATABASE_URL` must name a dedicated hosted Supabase test project.** Tests never fall back to `DATABASE_URL`, never reset a remote database, and apply migrations forward-only.
- **Hard-budget checks are not reservation-safe under concurrent model calls.** All configured periods are enforced and evaluated, but true strict caps require estimated-cost reservation and reconciliation around provider calls.
- **HTTP e2e tests use SWC** so Nest constructor metadata matches the production TypeScript build. Keep `pnpm test:e2e` in the completion gate.
- **Token usage is reported as zeros** in OpenAI-shaped responses. A multi-turn orchestration has no single token count; `ai_usage_events` is the billing source of truth.

---

## Repository layout

```
docs/adr/                 architecture decision records
supabase/migrations/      versioned SQL — applies to the hosted Supabase PostgreSQL project
backend/
  src/
    main.ts               HTTP entrypoint
    worker.ts             outbox relay + scheduler (separate process)
    shared/               config, database, crypto, logging, context, events, http
    auth/                 JWT verification, guards, decorators
    feature-flags/        org-level flags
    intelligence/         stateless application intelligence services
    insights/             insights engine + generators
    llm/                  provider port, OpenRouter adapter, router, usage, budgets
    chat/                 OpenAI-compatible endpoint
    jobs/                 queues, relay, scheduler
    health/
  test/
```
