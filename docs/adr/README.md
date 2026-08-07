# Architecture Decision Records

Every major technical decision in Capere AI is recorded here. An ADR exists to
capture the decision, the alternatives that were considered, and the reasoning —
so that a future engineer asking "why is this the stack?" gets a documented
answer, not archaeology through git history.

## Format

One file per ADR, numbered `NNNN`, following the lightweight
Michael Nygard ADR template:

- **Status** — Accepted / Proposed / Superseded by NNNN
- **Date**
- **Context** — the forces at play
- **Decision** — what we chose, stated plainly
- **Rationale** — why this decision wins on the forces in context
- **Alternatives considered** — and why each lost
- **Consequences** — positive and negative, with mitigations

## Index

| ADR  | Title                                                                                             | Status                     |
| ---- | ------------------------------------------------------------------------------------------------- | -------------------------- |
| 0001 | [NestJS as the application framework](0001-nestjs-as-application-framework.md)                    | Accepted                   |
| 0002 | [Kysely and hand-written SQL migrations over an ORM](0002-kysely-over-orm.md)                     | Accepted                   |
| 0003 | [Supabase as the Postgres and Auth provider](0003-supabase-as-database-and-auth.md)               | Accepted                   |
| 0004 | [Two-tier event bus (in-process + transactional outbox)](0004-two-tier-event-bus.md)              | Accepted                   |
| 0005 | [OpenRouter as the model gateway](0005-openrouter-as-model-gateway.md)                            | Accepted                   |
| 0006 | [Open WebUI as the AI interface](0006-open-webui-as-interface.md)                                 | Accepted                   |
| 0007 | [BullMQ for background jobs, with database-driven scheduling](0007-bullmq-for-background-jobs.md) | Accepted                   |
| 0008 | [Qdrant as the vector store](0008-qdrant-as-vector-store.md)                                      | Accepted (adopted Phase 2) |
| 0009 | [Budget reservation and reconciliation boundary](0009-budget-reservation-boundary.md)             | Proposed                   |
| 0010 | [Stateless layered intelligence](0010-stateless-layered-intelligence.md)                          | Accepted                   |

## Known open items

Recorded here rather than buried in code comments, because they are decisions
deferred rather than decisions made:

- **TLS certificate verification** (`shared/database/ssl.ts`) — connections to
  Supabase are encrypted but the certificate is not verified
  (`rejectUnauthorized: false`, the documented Supabase default). This is
  MITM-able and should be resolved by pinning Supabase's CA before production.
- **Cron expression parsing** (`jobs/scheduler.service.ts`) — the
  `hourly`/`daily`/`weekly`/`monthly` shorthands are exact; a 5-field cron
  expression currently falls back to hourly with a warning.
- **Separate test database** — `TEST_DATABASE_URL` must point at a dedicated
  hosted Supabase test project. Tests never fall back to the application
  database and apply migrations forward-only.
- **Strict concurrent budget caps** — current preflight checks evaluate every
  period but require reservation/reconciliation for mathematical concurrency
  safety. See ADR-0009.
- **Vector-store tenant isolation** (Phase 2) — Qdrant filtering is
  application-enforced, with no database-level backstop equivalent to RLS. See
  ADR-0008.
