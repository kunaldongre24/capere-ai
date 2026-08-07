# ADR-0009: Budget reservation and reconciliation boundary

- **Status:** Proposed for Phase 1 completion
- **Date:** 2026-08-03
- **Phase:** 1

## Context

`ai_usage_events` records the exact integer micro-USD cost after a provider call. A preflight budget query prevents calls after already-recorded spend reaches a hard limit, but it cannot prevent two concurrent calls from both observing the same remaining balance. Holding a PostgreSQL lock across an external model call would create long-lived transactions and still would not know the final provider cost.

## Decision

The current Phase 1 implementation keeps the preflight hard-limit gate and evaluates every configured budget period after usage is recorded. It does **not** claim strict concurrent reservation safety.

Strict enforcement requires a reservation boundary with:

1. A conservative estimated cost before provider invocation, derived from the selected model, input tokens, and configured maximum output tokens.
2. An atomic database reservation keyed by organization, budget period, and request ID.
3. Reconciliation after success, failure, fallback, stream interruption, or cancellation.
4. Expiry/recovery for abandoned reservations.
5. Integer/bigint-safe accounting throughout the reservation and ledger paths.

This must be implemented as one coherent migration and router change. A partial lock-only solution is rejected because it would provide misleading protection while holding database resources across network calls.

## Consequences

Until reservation/reconciliation exists, configured budgets are monitoring and preflight enforcement, not a mathematically strict concurrent cap. Production operators should size hard limits with concurrency headroom and monitor `ai_usage_events` plus budget alerts.
