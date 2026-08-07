# ADR-0008: Qdrant as the vector store

- **Status:** Accepted — decided in Phase 1, adopted in Phase 2
- **Date:** 2026-08-03
- **Phase:** 1 (decision), 2 (implementation)

## Context

Phase 2 builds the knowledge system: a RAG layer over the CPA playbook, SEO SOPs, GBP SOPs, sales and marketing SOPs, and implementation guides. It needs document ingestion, chunking, embedding generation, semantic search and citation support.

This ADR is written in Phase 1 rather than Phase 2 because the decision shapes Phase 1 code: `SemanticMemory` is a port with a null implementation today, and `QDRANT_URL` is already a validated config value. Deciding now means Phase 2 supplies an adapter rather than renegotiating the interface.

## Decision

Use **Qdrant** as the vector database, behind the existing `SemanticMemory` port (`hermes/memory/memory.interface.ts`).

Phase 1 binds `NullSemanticMemory`, which returns no hits and reports `available: false`. Phase 2 replaces that binding in `hermes.module.ts` with a Qdrant-backed adapter. No caller changes.

## Rationale

- **Payload filtering is a tenancy requirement, not a nicety.** Every vector must be filterable by `organization_id` so one firm's playbook customizations can never surface in another firm's answers. Qdrant's filtered search applies the predicate during traversal rather than post-filtering results, so recall stays correct under tenant scoping — a post-filter can return an empty page while relevant vectors exist beyond the cutoff.
- **Self-hostable and already in `docker-compose.yml`.** No third-party data-processing agreement needed for documents that may contain client-identifying material.
- **Operationally simple.** A single binary, no separate coordinator or index-build step.
- **Named in the specification.** The stack was specified; this ADR records why it holds up rather than treating it as arbitrary.

## Alternatives considered

**pgvector (Postgres extension).** Genuinely tempting: no new service, vectors live beside the tenant data, RLS could enforce isolation on the vector table itself using the exact same policy mechanism as everything else — a real architectural consistency win. Rejected for Phase 2 because HNSW index builds are memory-hungry and lock-prone on a hosted Supabase instance sized for transactional load, and mixing an ANN workload with the primary OLTP database risks the latter. Worth revisiting if the corpus stays small (< ~100k chunks), where pgvector's simplicity would likely win.

**Pinecone.** Fully managed, zero operations. Rejected on data residency and cost: playbook content and firm-specific SOPs would leave our infrastructure, requiring a data-processing agreement, and per-vector pricing compounds across thousands of firms.

**Weaviate.** Comparable capability with built-in vectorization modules. Rejected as heavier to operate for no advantage on this workload; Capere generates embeddings itself via the LLM layer, so built-in vectorizers are not useful.

**Chroma.** Simplest developer experience. Rejected: less mature multi-tenancy and filtering, which is precisely the axis that matters most here.

## Consequences

**Positive.** Correct tenant-filtered search. Self-hosted, so document content stays on our infrastructure. Already in the compose file, so Phase 2 needs no new infrastructure decision. The port means the choice is reversible.

**Negative.**

- **Another stateful service** to run, monitor, back up and secure.
- **Two sources of truth.** Chunk text and metadata live in Postgres; vectors live in Qdrant. They can drift — a document deleted in Postgres whose vectors remain would surface as a citation to a nonexistent source. Phase 2 must handle this explicitly, most likely by making Qdrant writes a subscriber to a domain event rather than a direct call.
- **Tenant isolation is enforced by application-supplied filters, not RLS.** Unlike every other data store in Capere, a forgotten `organization_id` filter here is not caught by a database-level backstop. Phase 2 should therefore route all searches through a single method that applies the filter, and test it the way `rls.spec.ts` tests Postgres.

**Phase 1 consequence worth stating plainly.** Because semantic memory is a null implementation, the context builder explicitly tells the model that the knowledge base was not consulted, rather than silently omitting it. A model that believes it searched the playbook and found nothing will answer confidently from priors — which is exactly the fabrication risk this product cannot afford.
