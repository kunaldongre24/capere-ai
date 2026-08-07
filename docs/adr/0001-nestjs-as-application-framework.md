# ADR-0001: NestJS as the application framework

- **Status:** Accepted
- **Date:** 2026-08-03
- **Phase:** 1

## Context

Capere AI is the intelligence layer over GoHighLevel. It is not a thin CRUD API — it has to host an orchestration engine, a tool registry, background workers, scheduled jobs, an event bus, multi-tenant auth with row-level isolation, and an OpenAI-compatible streaming endpoint.

The master specification calls for Clean Architecture, SOLID, and DDD where practical, with an explicit rule that business logic never lives in controllers and every external system sits behind its own adapter. That rule is only enforceable if the framework makes dependency inversion the path of least resistance.

The project is expected to grow to serve thousands of CPA firms and to be worked on by more than one engineer, so consistency across modules matters more than per-module cleverness.

## Decision

Use **NestJS 10** with the Express platform adapter.

## Rationale

- **DI container is first-class.** Ports and adapters, the pattern the whole integration strategy depends on, become idiomatic rather than hand-rolled. A `LlmProvider` interface with a fake and a real implementation is a provider token swap, not a factory function threaded through call sites.
- **Module boundaries are enforced by the framework.** Each bounded context (`auth`, `hermes`, `insights`, `llm`) is a module with an explicit surface. This is the mechanism that keeps Phase 3–6 additions from turning into a ball of mud.
- **Guards, interceptors and filters map exactly onto our cross-cutting needs** — JWT verification, org-membership checks, role checks, feature-flag gating, the response envelope, request correlation, and the global exception filter are framework concepts rather than middleware we invent.
- **First-party OpenAPI generation** (`@nestjs/swagger`) satisfies the documented-API requirement from decorators already present for validation, so docs cannot drift from DTOs.
- **The worker process shares the same DI graph.** `worker.ts` boots a NestJS application context without the HTTP layer, so jobs reuse the exact services the API uses. No duplicated wiring between web and worker.

## Alternatives considered

**Express alone.** Lightest and most flexible; the specification lists it as an acceptable fallback. Rejected because every structural thing we need — DI, module boundaries, lifecycle hooks, guard composition, OpenAPI from types — would be hand-built and inconsistently applied. At this system's scope that is a net cost, and the discipline degrades as the team grows.

**Fastify platform adapter instead of Express.** Meaningfully faster on raw throughput. Rejected for Phase 1 because this workload is dominated by LLM latency and database round-trips, not HTTP parsing, and the Express ecosystem for SSE streaming and middleware is better-trodden. NestJS keeps this reversible: it is a platform-adapter swap if profiling later shows HTTP overhead matters.

**Encore / tRPC / other opinionated stacks.** Rejected: tRPC assumes a TypeScript client, but our primary consumers are Open WebUI (OpenAI wire format), Looker Studio, and GoHighLevel webhooks — all of which need conventional REST/HTTP.

## Consequences

**Positive.** Consistent structure across all modules; testability via DI overrides is trivial, which is what makes the fake-provider strategy viable with no credentials; OpenAPI stays in sync with DTOs; workers and API share one dependency graph.

**Negative.** Heavier startup and a steeper learning curve than bare Express. Decorator-heavy code depends on `reflect-metadata` and `emitDecoratorMetadata`. NestJS 10 pins the major versions of several first-party packages together, so upgrades happen as a coordinated set rather than piecemeal.

**Mitigation.** Business logic lives in plain, framework-agnostic services that receive dependencies through constructors. If NestJS is ever replaced, the domain layer moves without rewriting — only the controllers, module wiring, guards and filters are Nest-specific.
