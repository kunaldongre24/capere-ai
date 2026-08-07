# Capere AI — backend

The intelligence layer that sits on top of GoHighLevel.

- **GHL owns the CRM** — contacts, opportunities, conversations, calendars, reviews, workflows. Capere never duplicates these; it stores references (`ghl_location_id`, `ghl_contact_id`, …).
- **Capere owns the intelligence** — Hermes orchestration, AI agents, knowledge, insights, recommendations, SEO/analytics/reporting.

This package contains the NestJS API and the BullMQ worker, sharing one DI graph.

The included Open WebUI deployment is intentionally single-tenant. Its API key
is bound to one organization, so production deployments require one isolated
Open WebUI instance per CPA firm until an identity bridge is implemented.

## Layout

```
src/
  main.ts            # HTTP entrypoint
  worker.ts          # BullMQ worker entrypoint (separate process)
  shared/            # config, database, crypto, logging, context, events, http
  auth/              # Supabase JWT verification, guards, decorators
  organizations/     # org + membership + users
  integrations/      # credential vault + provider registry
  hermes/            # orchestration engine (planner/context/memory/.../agents)
  insights/          # insights engine
  llm/               # OpenRouter adapter, model router, usage, budgets
  chat/              # OpenAI-compatible endpoint for Open WebUI
  jobs/              # BullMQ queues, scheduler, DLQ
  health/            # health/readiness endpoints
```

## Development

```bash
pnpm install                    # from repo root
pnpm infra:up                   # redis + qdrant in Docker
cp .env.example .env            # configure Supabase and other credentials
pnpm migrate                    # apply supabase/migrations to Supabase PostgreSQL
pnpm dev                        # API on :3000
pnpm dev:worker                 # BullMQ worker process
```

## Tests

```bash
pnpm test                       # unit + integration against TEST_DATABASE_URL
pnpm test:e2e                   # full-app HTTP suite against TEST_DATABASE_URL
```

Use a dedicated Supabase test project. The fake OpenRouter provider means AI
provider credentials are not required for the test suite.
