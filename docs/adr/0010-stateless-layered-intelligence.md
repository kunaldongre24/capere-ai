# ADR 0010: Stateless Layered Intelligence

**Status:** Accepted

**Date:** 2026-08-04

## Context

The original Hermes service coordinated organization context, conversation memory, semantic retrieval, prompt resolution, model-selected tools, response review, and persistence. Although it stored durable state externally, it formed one central runtime abstraction and made unrelated capabilities depend on an orchestrator identity.

## Decision

Use stateless application services and durable workflows. API and worker replicas retain no organization or conversation state between requests. Optional sessions live in PostgreSQL, semantic knowledge lives in Qdrant, jobs live in BullMQ, and provider data remains behind domain services and adapters.

`GenerateChatResponseUseCase` coordinates one chat request. Context, memory, prompts, tools, model execution, and review remain independent services. General chat may perform capped read-only tool execution. Mutations and long-running work use explicit application use cases, approval records, and BullMQ jobs.

The preferred Open WebUI capability is `capere-intelligence`; `capere-hermes` remains a compatibility alias. Historical database rows labelled `hermes` are not rewritten.

Legacy TypeScript import shims under `src/hermes/` are retained through Phase 4 and removed at the Phase 5 breaking-change boundary. New code must import from `src/intelligence/`; runtime source is checked to prevent dependencies on the shims.

## Consequences

- Any API replica can serve any request or continue any durable session.
- Domain workflows no longer depend on a central AI orchestrator.
- Tool permissions and organization isolation remain enforced outside model decisions.
- Known mutations are deterministic and auditable rather than hidden inside chat reasoning.
- The legacy model ID and database enum value must remain readable during the compatibility window.
