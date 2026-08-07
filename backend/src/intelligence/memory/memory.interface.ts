import type { LlmMessage } from '../../llm';

/**
 * The four memory layers, behind one facade.
 *
 * Separating them is not bookkeeping — each has a different lifetime, a
 * different storage medium, and a different failure mode:
 *
 *   - **Conversation** — the turn-by-turn transcript of one session. Postgres.
 *     Lifetime: the session. Losing it means the assistant forgets what was
 *     just said.
 *
 *   - **Business** — durable facts about the firm: service lines, target
 *     markets, stated goals, current KPIs. Postgres, per organization.
 *     Lifetime: indefinite. This is what makes Hermes sound like it knows the
 *     client rather than meeting them for the first time on every request.
 *
 *   - **Working** — scratch state within a single orchestration run: the plan,
 *     intermediate tool results, retry counts. In-memory.
 *     Lifetime: one run. Deliberately NOT persisted; persisting it would leak
 *     one request's reasoning into the next.
 *
 *   - **Semantic (RAG)** — retrieval over the CPA playbook and SOPs.
 *     Lifetime: indefinite, rebuilt on ingestion.
 *     PHASE 1: a null implementation. The port is real so Phase 2 supplies the
 *     vector-backed version without touching a single caller.
 *
 * Collapsing these into one "memory" bag would mean either persisting scratch
 * state or losing durable facts — and would make the Phase 2 RAG swap a
 * rewrite instead of a binding change.
 */

// --- Conversation ----------------------------------------------------------

export interface ConversationTurn {
  readonly role: LlmMessage['role'];
  readonly content: string;
  readonly sequence: number;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly toolArguments?: unknown;
  readonly createdAt: Date;
}

export interface ConversationMemory {
  /** Recent turns for a session, oldest first. */
  recent(organizationId: string, sessionId: string, limit?: number): Promise<ConversationTurn[]>;
  append(params: {
    sessionId: string;
    organizationId: string;
    role: LlmMessage['role'];
    content: string;
    toolCallId?: string;
    toolName?: string;
    toolArguments?: unknown;
    metadata?: Record<string, unknown>;
  }): Promise<ConversationTurn>;
}

// --- Business --------------------------------------------------------------

export interface BusinessFact {
  /** Dotted namespace, e.g. 'firm.profile', 'goals.q3'. */
  readonly key: string;
  readonly value: unknown;
  readonly source: string;
  readonly confidence?: number;
  readonly updatedAt: Date;
}

export interface BusinessMemory {
  all(organizationId: string): Promise<BusinessFact[]>;
  get(organizationId: string, key: string): Promise<BusinessFact | undefined>;
  set(params: {
    organizationId: string;
    key: string;
    value: unknown;
    source?: string;
    confidence?: number;
    expiresAt?: Date;
  }): Promise<void>;
  forget(organizationId: string, key: string): Promise<void>;
}

// --- Working ---------------------------------------------------------------

/**
 * Scratch state for one orchestration run.
 *
 * Synchronous by design: it is a Map, and making it async would force every
 * call site to await something that never touches I/O.
 */
export interface WorkingMemory {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  has(key: string): boolean;
  delete(key: string): void;
  snapshot(): Record<string, unknown>;
  clear(): void;
}

// --- Semantic (RAG) --------------------------------------------------------

export interface SemanticHit {
  readonly documentId: string;
  readonly chunkId: string;
  readonly content: string;
  /** 0-1 similarity. */
  readonly score: number;
  /** Enough to render a citation: title, source URL, section. */
  readonly citation: {
    readonly title: string;
    readonly source?: string;
    readonly section?: string;
  };
}

export interface SemanticMemory {
  /** True when a real vector store is wired up (Phase 2). */
  readonly available: boolean;
  search(params: {
    organizationId: string;
    query: string;
    limit?: number;
    minScore?: number;
  }): Promise<SemanticHit[]>;
}

// --- Facade ----------------------------------------------------------------

/** DI token for the semantic port, so Phase 2 rebinds it without code changes. */
export const SEMANTIC_MEMORY = Symbol('SEMANTIC_MEMORY');

/**
 * Context assembled independently for one stateless intelligence request.
 *
 * `semanticAvailable` is surfaced explicitly so the context builder can say
 * "the playbook was not consulted" rather than silently omitting it — an
 * assistant that quietly answers without its knowledge base is worse than one
 * that admits the gap.
 */
export interface MemorySnapshot {
  readonly conversation: ConversationTurn[];
  readonly business: BusinessFact[];
  readonly semantic: SemanticHit[];
  readonly semanticAvailable: boolean;
  readonly working: Record<string, unknown>;
}
