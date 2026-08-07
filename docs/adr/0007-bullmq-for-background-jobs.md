# ADR-0007: BullMQ for background jobs, with database-driven scheduling

- **Status:** Accepted
- **Date:** 2026-08-03
- **Phase:** 1

## Context

Capere needs background work: syncing GA4/GSC/GBP/GHL, running SEO audits, generating embeddings, producing weekly reports and daily briefs. These jobs are long-running (an SEO audit takes minutes), rate-limited by upstream APIs, and must survive process restarts without losing work or double-charging an organization's AI budget.

Requirements: retries with backoff, a dead-letter path so a permanently failing job is inspectable rather than silently dropped, recurring schedules, per-queue concurrency so one slow provider cannot starve others, and a separate worker process so a CPU-bound job never blocks the HTTP event loop.

There is also a product requirement that shapes the scheduling decision specifically: schedules are **per-organization and user-editable** — "run my SEO audit weekly on Mondays" is a setting a CPA firm owner changes in the UI.

## Decision

Use **BullMQ on Redis** for the queue seams, with a dedicated worker entrypoint (`src/worker.ts`) separate from the HTTP entrypoint (`src/main.ts`). Phase 1 verifies queue connectivity at worker startup, but does not enqueue scheduled executions into BullMQ or register BullMQ processors yet.

Use **database-driven scheduling and execution in Phase 1**: `SchedulerService` polls `capere.scheduled_jobs`, materializes leased `job_runs` atomically, and handles retry/dead-letter transitions in PostgreSQL. The transactional outbox relay also claims and retries directly from PostgreSQL. Later phases may add BullMQ dispatchers/processors, but must preserve deterministic run IDs and recovery semantics so a Postgres/Redis crash window is not reintroduced.

## Rationale

- **Queues are declared centrally** in `queue-registry.service.ts`, one per concern, so a wedged content-generator worker cannot starve the analytics queue.
- **Scheduling lives in Postgres because schedules are tenant data.** BullMQ's repeatable jobs live in Redis, which makes them invisible to application queries, awkward to expose in a UI, and lost on a Redis flush. Keeping them in Postgres means they are queryable, auditable, editable transactionally alongside other tenant data, and survive Redis entirely.
- **`FOR UPDATE SKIP LOCKED` makes the scheduler safe to run in several replicas.** Each claims a disjoint set of due jobs, and `next_run_at` is advanced inside the claiming transaction so a slow job cannot be picked up twice.
- **`job_runs` gives operators SQL visibility.** Diagnosing a failure does not require a Redis client.
- **The worker shares the API's DI graph.** `worker.ts` boots the same `AppModule` without the HTTP layer, so jobs reuse the exact services the API uses rather than a parallel copy that drifts.

## Alternatives considered

**pg-boss (Postgres-backed queues).** Attractive: removes Redis entirely, and jobs become transactional with the data they touch. Rejected because the architecture already commits to Redis for caching, so it is not an additional dependency; and BullMQ's rate limiter and per-queue concurrency are more mature, which matters when six upstream APIs each have distinct quotas. A reasonable future migration if Redis proves operationally annoying.

**BullMQ repeatable jobs for scheduling.** The obvious default. Rejected for the reason above — per-organization user-editable schedules are tenant data, and putting them in Redis makes them invisible to the application that must display and edit them.

**Temporal.** Genuinely better for long multi-step workflows with compensation logic, which Phase 6's automation engine may eventually want. Rejected now as disproportionate: it requires operating a Temporal cluster, and Phase 1's jobs are individually simple.

**Cloud-native queues (SQS + EventBridge).** Rejected: couples the architecture to one cloud provider and makes local development materially harder, contradicting the requirement that everything be verifiable offline.

**`node-cron` in-process.** Rejected outright: no persistence, no retries, and every API replica would run every scheduled job — producing duplicate AI spend against customer budgets.

## Consequences

**Positive.** Phase 1 schedules and run history are queryable SQL, editable per organization, survive Redis loss, and have explicit leases, retries, and dead-letter states. The worker scales independently of the API. BullMQ queue names and retry defaults are established and connectivity-verified for later processors.

**Negative.**

- **BullMQ execution is deferred.** No Phase 1 job is added to a BullMQ queue and no BullMQ `Worker` processor is registered. Queue isolation, BullMQ stalled-job recovery, and BullMQ rate limits become operational only when later-phase processors are implemented.
- **The worker still requires Redis at startup** because the adopted queue seams must be usable before it reports ready; PostgreSQL remains the Phase 1 durable execution source.
- **The scheduler polls** (30s interval), so a job may start up to 30s after its due time. Fine for hourly-and-longer work; a tighter guarantee would need a different mechanism.
- **Cron expressions are not yet parsed.** `SchedulerService.nextRunAt` handles the `hourly`/`daily`/`weekly`/`monthly` shorthands exactly; a 5-field cron expression is accepted, logged as a warning, and treated as hourly. A job running more often than requested is a better failure than one that silently never runs — but a cron parser is required before advertising precise cron scheduling.
- **Redis is a hard dependency for background work.** If it is down, queued jobs stop; the API itself continues serving requests.

**Follow-up.** Phase 1 ships the outbox relay and an `insights-sweep` job. The sync, audit, embedding and report workers arrive with their integrations in Phase 3.
