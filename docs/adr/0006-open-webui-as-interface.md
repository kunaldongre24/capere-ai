# ADR-0006: Open WebUI as the AI interface

- **Status:** Accepted
- **Date:** 2026-08-03
- **Phase:** 1

## Context

CPA firm staff need to talk to Hermes. A production chat interface is not a small feature: streaming responses, conversation history, file upload, markdown and code rendering, model selection, mobile layout, accessibility, and a settings surface. Building it well is weeks of frontend work that competes directly with building the intelligence layer that actually differentiates the product.

The specification is explicit on this point: _"Do not build a custom chat frontend."_

## Decision

Use **Open WebUI**, pointed at Capere as a custom OpenAI-compatible provider via `OPENAI_API_BASE_URL`. Capere exposes `/v1/chat/completions` and `/v1/models` matching the OpenAI wire format. Operators issue an organization-bound key with `pnpm api-key:issue <organization-id> "Open WebUI" office_manager`, store the one-time value as `OPEN_WEBUI_API_KEY`, and Docker Compose passes it to Open WebUI as `OPENAI_API_KEY`. No static default credential exists.

## Rationale

- **The OpenAI protocol is the integration surface, and it is small.** Two endpoints get streaming, history, file upload, markdown rendering and model selection for free. Every one of those is a feature we would otherwise build and maintain.
- **The models advertised are capabilities, not raw models.** `/v1/models` returns `capere-hermes`, not `anthropic/claude-3.5-sonnet`. That indirection is the important part: exposing raw provider models would let a user bypass Hermes entirely — no organization context, no tools, no budget accounting, no reflection. Every conversation goes through the orchestrator.
- **API-key auth fits a machine client.** Open WebUI authenticates with a Capere-issued key (hashed, prefix-indexed) rather than a Supabase user JWT, which is the right model for a service-to-service caller.
- **Speaking a standard protocol keeps the interface replaceable.** If Open WebUI stops fitting, any OpenAI-compatible client works, and a future bespoke UI can target the same endpoints.

## Alternatives considered

**Build a custom React chat UI.** Full control over branding and product-specific affordances. Rejected: explicitly ruled out by the specification, and it would consume Phase 1's remaining budget on solved problems. Worth revisiting only once the intelligence layer is proven and UI becomes the constraint.

**Embed a chat widget library (assistant-ui, Vercel AI SDK UI).** Less work than from scratch, more control than Open WebUI. Rejected for Phase 1 because it still requires a host application, auth wiring, history persistence and deployment — real work for a marginal gain over a product that already does all of it.

**Chat inside a GoHighLevel custom menu.** Where users already spend their day, no separate login. Rejected as premature: the SEO Command Center and AI CMO menus are Phase 5, and iframe embedding constrains streaming and file upload. The OpenAI-compatible endpoint means this remains possible later without backend changes.

## Consequences

**Positive.** A production-quality chat interface for the cost of two endpoints. Streaming, history, file upload and markdown work out of the box. Users can be onboarded immediately. Any OpenAI-compatible client can talk to Capere.

**Negative.**

- **Three deliberate deviations from Capere's own API conventions**, all forced by the external contract: the chat controller is `VERSION_NEUTRAL` and excluded from the `/api` prefix (the path is fixed by OpenAI), it is `@RawResponse()` (the `{ data, meta }` envelope would be unparseable to the client), and it uses `@ApiKeyAuth()` rather than JWT.
- **Streaming is chunked, not true token streaming.** Hermes runs its full pipeline — context, tools, reflection — before producing a final answer, so there is no upstream token stream to forward. Intermediate tool-calling turns are not the answer. The final text is chunked instead, which keeps incremental rendering working while preserving the guarantee that reflection has vetted every word the user sees. First-token latency is therefore higher than a raw model proxy; that is a deliberate trade of perceived speed for correctness.
- **Token usage is reported as zeros** in the OpenAI response. A multi-turn orchestration has no single token count, and fabricating one would be worse than reporting nothing. `ai_usage_events` is the source of truth for billing.
- **Limited branding control**, and Open WebUI's own release cadence is a dependency.
- **Open WebUI keeps its own database** for its users and settings, separate from Capere's Supabase project — two stores to back up.
