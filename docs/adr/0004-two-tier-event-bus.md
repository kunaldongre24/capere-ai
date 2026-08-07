# ADR-0004: Two-tier event bus (in-process + transactional outbox)

- **Status:** Accepted
- **Date:** 2026-08-03
- **Phase:** 1

## Context

Capere's modules must not call each other directly. When GA4 data syncs, the insights engine should react; when an insight is generated, the recommendation engine and the weekly report should react. Wiring those as direct method calls produces a dependency graph where the analytics module imports the insights module imports the reporting module — and by Phase 5 nothing can be changed in isolation.

The constraint that shapes the design: **Postgres and Redis are separate systems.** A service that writes state to Postgres and then pushes a job to Redis has a window between the two. A crash in that window leaves the system inconsistent in one of two directions:

- state committed, event lost → downstream never reacts, silently
- event published, transaction rolled back → subscribers act on a fact that never became true

Both are real. The first is worse because it is invisible.

## Decision

Two delivery paths, chosen per use case:

1. **In-process** (`InProcessEventBus`) — synchronous, same transaction, no durability. For cheap work that must happen with the state change: cache invalidation, in-memory projections.

2. **Transactional outbox** (`OutboxService` → `domain_events` table → `OutboxRelayWorker` → subscribers) — the event row is INSERTed in the same transaction as the state change, so either both commit or neither does. A relay in the worker process claims rows with `FOR UPDATE SKIP LOCKED`, stamps a claim token and timestamp, and dispatches them. Claims older than five minutes are reclaimable after a worker crash; consume/fail updates require the matching token so a stale worker cannot acknowledge another worker's claim.

## Rationale

- **The outbox eliminates the crash window entirely.** The event and its cause are one atomic write. There is no ordering of two systems to get wrong.
- **`SKIP LOCKED` makes the relay horizontally scalable.** Each replica claims a disjoint set of rows. Without it, relays either serialize behind one another or double-publish.
- **In-process handlers stay available for work that does not deserve a round trip.** Pushing a cache invalidation through Redis and back would add latency to a request for no durability benefit.
- **A failing in-process subscriber cannot fail the publisher.** Errors are logged and swallowed, because a subscriber must not be able to reject a request that already succeeded. Work that _must_ not be lost goes in the durable path, where it is retried.
- **Retry and dead-lettering are explicit.** `attempts` versus `max_attempts` in the table; once exhausted, the row stops being claimed and appears in the DLQ view rather than being retried forever.

## Alternatives considered

**In-process `EventEmitter` only.** Simplest, no new table, no relay. Rejected: events are lost on crash, and a slow handler blocks the publisher's request. For `IntegrationDisconnected` — which should generate an insight the customer acts on — silent loss is unacceptable.

**Everything through BullMQ, no outbox.** Uniform and durable, all events visible in Redis. Rejected because it does not solve the atomicity problem at all: the enqueue still happens outside the Postgres transaction, so the crash window remains. It also adds queue latency to trivial in-request work.

**Postgres `LISTEN`/`NOTIFY`.** Native, no polling. Rejected: `NOTIFY` payloads are capped at 8000 bytes, notifications are dropped entirely if no listener is connected, and they do not survive a restart. That is at-most-once delivery, which is the wrong guarantee for events that drive customer-visible behaviour.

**A dedicated broker (Kafka, NATS, RabbitMQ).** Correct at large scale. Rejected for Phase 1 as unjustified operational weight: another system to run, monitor and secure, for an event volume Postgres handles without noticing. The outbox is the standard stepping stone, and it does not preclude adding a broker later — the relay becomes the producer.

## Consequences

**Positive.** Events cannot be lost or phantom-published. The relay scales horizontally. Retry and DLQ are queryable SQL rather than broker internals. Events survive a Redis flush. Modules stay decoupled, so Phases 3–6 add subscribers without touching publishers.

**Negative.** Delivery is at-least-once, so **every subscriber must be idempotent** — this is the real cost, and it is a discipline that must hold as subscribers are added. The relay polls, so there is up to ~2s of latency for a non-urgent event. The `domain_events` table grows and will need a retention policy. Two mechanisms means engineers must choose correctly between them.

**Mitigation.** Idempotency is by event ID, and the insights engine demonstrates the pattern by deduplicating on `dedupe_key` rather than assuming exactly-once delivery. The relay's polling interval adapts: 50ms while draining a full batch, 2s when idle.
