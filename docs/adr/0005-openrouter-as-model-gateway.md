# ADR-0005: OpenRouter as the model gateway

- **Status:** Accepted
- **Date:** 2026-08-03
- **Phase:** 1

## Context

The product specification names four model families as primary: Hermes, GPT, Claude and Kimi. Those come from four different vendors (Nous Research, OpenAI, Anthropic, Moonshot), each with its own API shape, auth scheme, rate limits and billing.

Capere also needs per-task routing — reflection is a cheaper job than generation, and paying frontier prices to critique every answer would roughly double cost for a fraction of the value — plus fallback when a provider is rate-limited or down, and exact per-call cost attribution to drive organization budgets.

## Decision

Use **OpenRouter** as a single gateway, behind a `LlmProvider` port with two implementations: `OpenRouterProvider` (real) and `FakeLlmProvider` (deterministic, offline). Both must pass the same contract test suite.

## Rationale

- **One integration, four vendors.** OpenRouter speaks the OpenAI chat-completions format across all of them, so adding Kimi alongside Claude is a model-id string, not a new adapter. Four separate SDKs would mean four auth flows, four error taxonomies and four sets of streaming quirks.
- **Per-request routing is free.** Task-type fallback chains (`general`, `analytics`, `cheap`) are config, so switching which model serves reflection needs no code change.
- **One bill, one rate limit.** Materially simpler than reconciling four vendor invoices against per-organization usage.
- **Cost is computed locally, not trusted.** OpenRouter does not reliably return a cost, and cost feeds customer budgets. `model-pricing.ts` computes exact integer micro-USD from a local table, with a deliberately pessimistic fallback for unpriced models — over-reporting trips an alert someone investigates, under-reporting silently blows a budget.
- **The port makes credential-free development real.** With no `OPENROUTER_API_KEY`, the module binds the fake and the entire Hermes loop runs offline with no spend. That is not a mock in the loose sense: it is a second implementation held to the same contract, so swapping in a live key is verified rather than hoped.

## Alternatives considered

**Direct vendor SDKs (`@anthropic-ai/sdk`, `openai`, …).** No middleman, no added latency, immediate access to vendor-specific features like Anthropic's prompt caching. Rejected for Phase 1: four adapters, four error taxonomies, four billing reconciliations, and routing logic we would write ourselves. Worth revisiting if a vendor-specific feature becomes load-bearing — the port means one new adapter, not a rewrite.

**LiteLLM proxy.** Similar aggregation, self-hosted, more model coverage. Rejected because it is another service to deploy, monitor and secure. OpenRouter is hosted and removes that operational surface entirely.

**LangChain / LlamaIndex.** Provider abstraction plus tooling. Rejected as the wrong shape: they want to own the orchestration loop, and Hermes _is_ our orchestration loop with explicit planner/context/memory/reasoning/reflection stages. Adopting one would mean fighting its abstractions or bypassing them.

## Consequences

**Positive.** One adapter for all four model families; task-type routing and fallback in config; exact integer cost accounting; the fake provider makes CI and local development free and deterministic; adding a model is a string change.

**Negative.**

- **A single point of failure.** If OpenRouter is down, every model call fails regardless of which underlying vendor is healthy. The fallback chain does not help, since it routes _through_ OpenRouter.
- **Added latency.** One extra network hop. Negligible against multi-second model inference.
- **The pricing table needs maintenance.** Rates change. An unpriced model silently uses the pessimistic fallback, so `OpenRouterProvider` logs a warning at boot listing any configured model without an explicit price.
- **Vendor-specific features are not reachable** unless OpenRouter exposes them.

**Mitigation.** The `LlmProvider` port is the insurance: adding a direct-vendor adapter is a new class and a binding change in `llm.module.ts`, with the existing contract suite proving it behaves identically.
