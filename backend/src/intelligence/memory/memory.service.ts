import { Inject, Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../shared/database';
import { AppException, ErrorCode } from '../../shared/http';
import type {
  BusinessFact,
  BusinessMemory,
  ConversationMemory,
  ConversationTurn,
  MemorySnapshot,
  SemanticMemory,
  WorkingMemory,
} from './memory.interface';
import { SEMANTIC_MEMORY } from './memory.interface';

/** In-memory scratch state for a single orchestration run. */
export class InMemoryWorkingMemory implements WorkingMemory {
  private readonly store = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }
  set(key: string, value: unknown): void {
    this.store.set(key, value);
  }
  has(key: string): boolean {
    return this.store.has(key);
  }
  delete(key: string): void {
    this.store.delete(key);
  }
  snapshot(): Record<string, unknown> {
    return Object.fromEntries(this.store);
  }
  clear(): void {
    this.store.clear();
  }
}

/**
 * Phase 1 semantic memory: a null implementation.
 *
 * Returns no hits and reports `available: false`, which the context builder
 * surfaces to the model as "the knowledge base was not consulted." That is
 * deliberately different from returning nothing silently — a model that thinks
 * it searched the playbook and found nothing will answer confidently from
 * priors, which is exactly the fabrication risk this system must avoid.
 *
 * Phase 2 replaces the SEMANTIC_MEMORY binding with a vector-store adapter. No caller
 * changes.
 */
@Injectable()
export class NullSemanticMemory implements SemanticMemory {
  readonly available = false;

  async search(): Promise<[]> {
    return [];
  }
}

/**
 * Memory facade over the four layers.
 *
 * Conversation and business memory read through the SERVICE client and scope
 * explicitly by organization_id. That is deliberate: memory assembly runs
 * inside worker jobs and scheduled briefs where no user JWT exists, so an
 * RLS-scoped connection is not available. Every query here carries an explicit
 * organization predicate — the app-layer half of the two-layer isolation model.
 */
@Injectable()
export class MemoryService implements ConversationMemory, BusinessMemory {
  private readonly logger = new Logger(MemoryService.name);

  constructor(
    private readonly database: DatabaseService,
    @Inject(SEMANTIC_MEMORY) private readonly semanticStore: SemanticMemory,
  ) {}

  // --- Conversation --------------------------------------------------------

  async recent(organizationId: string, sessionId: string, limit = 40): Promise<ConversationTurn[]> {
    // Take the LAST n by sequence, then restore chronological order — a plain
    // ascending limit would return the oldest turns and drop the recent
    // context that actually matters.
    const rows = await this.database.db
      .selectFrom('capere.conversation_messages')
      .select([
        'role',
        'content',
        'sequence',
        'tool_call_id',
        'tool_name',
        'tool_arguments',
        'metadata',
        'created_at',
      ])
      .where('organization_id', '=', organizationId)
      .where('session_id', '=', sessionId)
      .orderBy('sequence', 'desc')
      .limit(limit)
      .execute();

    return rows.reverse().map((row) => ({
      role: row.role,
      content: row.content,
      sequence: row.sequence,
      toolCallId: row.tool_call_id ?? undefined,
      toolName: row.tool_name ?? undefined,
      toolArguments: row.tool_arguments ?? undefined,
      metadata: this.record(row.metadata),
      createdAt: row.created_at,
    }));
  }

  async listSessions(params: {
    organizationId: string;
    userId: string;
    agent: string;
    limit?: number;
  }) {
    const sessions = await this.database.db
      .selectFrom('capere.ai_sessions')
      .select(['id', 'title', 'last_message_at', 'created_at'])
      .where('organization_id', '=', params.organizationId)
      .where('user_id', '=', params.userId)
      .where('agent', '=', params.agent as never)
      .where('status', '=', 'active')
      .orderBy('last_message_at', 'desc')
      .orderBy('created_at', 'desc')
      .limit(Math.min(params.limit ?? 12, 30))
      .execute();

    if (!sessions.length) return [];

    const assistantMessages = await this.database.db
      .selectFrom('capere.conversation_messages')
      .select(['session_id', 'content', 'sequence'])
      .where('organization_id', '=', params.organizationId)
      .where('session_id', 'in', sessions.map((session) => session.id))
      .where('role', '=', 'assistant')
      .where('tool_call_id', 'is', null)
      .orderBy('sequence', 'desc')
      .execute();
    const summaries = new Map<string, { title: string; preview: string | null }>();
    for (const message of assistantMessages) {
      if (summaries.has(message.session_id)) continue;
      const summary = this.conversationSummary(message.content);
      if (summary) summaries.set(message.session_id, summary);
    }

    return sessions.map((session) => ({
      ...session,
      summary_title: summaries.get(session.id)?.title ?? session.title,
      preview: summaries.get(session.id)?.preview ?? null,
    }));
  }

  private conversationSummary(content: string): { title: string; preview: string | null } | null {
    const cleanLines = content
      .replace(/\r/g, '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !/^[-|: ]+$/.test(line) && !line.includes('|'))
      .map((line) => line
        .replace(/^#{1,6}\s+/, '')
        .replace(/^[-*•]\s+/, '')
        .replace(/\*\*/g, '')
        .replace(/\s+/g, ' ')
        .trim())
      .filter(Boolean);
    if (!cleanLines.length) return null;
    const normalized = content.toLowerCase();
    const title = normalized.includes('google business profile') || normalized.includes('gbp')
      ? 'Google Business Profile overview'
      : normalized.includes('this week') || normalized.includes("week's focus") || normalized.includes('weekly priorit')
        ? 'Weekly marketing priorities'
        : normalized.includes('pipeline') || normalized.includes('revenue')
          ? 'Revenue and pipeline opportunities'
          : normalized.includes('search visibility') || normalized.includes('seo')
            ? 'Search visibility overview'
            : normalized.includes('website') || normalized.includes('traffic') || normalized.includes('conversion')
              ? 'Website performance overview'
              : 'CMO business review';
    const heading = cleanLines[0];
    const detail = cleanLines.find((line) => line !== heading && line.length >= 35) ?? null;
    const preview = detail && detail.length > 150 ? `${detail.slice(0, 147).trimEnd()}…` : detail;
    return { title, preview };
  }

  async sessionConversation(params: {
    organizationId: string;
    userId: string;
    sessionId: string;
  }) {
    await this.assertSessionAccess({
      organizationId: params.organizationId,
      sessionId: params.sessionId,
      userId: params.userId,
    });
    const session = await this.database.db
      .selectFrom('capere.ai_sessions')
      .select(['id', 'title', 'last_message_at', 'created_at'])
      .where('organization_id', '=', params.organizationId)
      .where('user_id', '=', params.userId)
      .where('id', '=', params.sessionId)
      .executeTakeFirstOrThrow();
    const messages = (await this.recent(params.organizationId, params.sessionId, 80))
      .filter((message) =>
        (message.role === 'user' || message.role === 'assistant') &&
        !message.toolCallId &&
        message.content.trim().length > 0,
      )
      .map((message) => ({
        role: message.role,
        content: message.content,
        sources: Array.isArray(message.metadata?.sources)
          ? message.metadata.sources.filter((source): source is string => typeof source === 'string')
          : [],
        createdAt: message.createdAt,
      }));
    return { ...session, messages };
  }

  async assertSessionAccess(params: {
    organizationId: string;
    sessionId: string;
    userId?: string;
    machineAccess?: boolean;
  }): Promise<void> {
    let query = this.database.db
      .selectFrom('capere.ai_sessions')
      .select('id')
      .where('id', '=', params.sessionId)
      .where('organization_id', '=', params.organizationId)
      .where('status', '=', 'active');

    if (params.userId && !params.machineAccess) {
      query = query.where('user_id', '=', params.userId);
    }

    const session = await query.executeTakeFirst();
    if (!session) {
      throw AppException.notFound(
        ErrorCode.NOT_FOUND,
        'AI session was not found or is not accessible',
      );
    }
  }

  async append(params: {
    sessionId: string;
    organizationId: string;
    role: ConversationTurn['role'];
    content: string;
    toolCallId?: string;
    toolName?: string;
    toolArguments?: unknown;
    metadata?: Record<string, unknown>;
  }): Promise<ConversationTurn> {
    // Sequence is assigned inside a transaction so two concurrent appends to the
    // same session cannot collide on UNIQUE (session_id, sequence).
    return this.database.transaction(async (trx) => {
      const session = await trx
        .selectFrom('capere.ai_sessions')
        .select('id')
        .where('id', '=', params.sessionId)
        .where('organization_id', '=', params.organizationId)
        .forUpdate()
        .executeTakeFirst();

      if (!session) {
        throw AppException.notFound(
          ErrorCode.NOT_FOUND,
          'AI session was not found or is not accessible',
        );
      }

      const last = await trx
        .selectFrom('capere.conversation_messages')
        .select('sequence')
        .where('session_id', '=', params.sessionId)
        .orderBy('sequence', 'desc')
        .limit(1)
        // Locks the row so a concurrent append waits rather than duplicating.
        .forUpdate()
        .executeTakeFirst();

      const sequence = (last?.sequence ?? 0) + 1;

      const row = await trx
        .insertInto('capere.conversation_messages')
        .values({
          session_id: params.sessionId,
          organization_id: params.organizationId,
          role: params.role,
          content: params.content,
          tool_call_id: params.toolCallId ?? null,
          tool_name: params.toolName ?? null,
          tool_arguments: params.toolArguments ? JSON.stringify(params.toolArguments) : null,
          sequence,
          metadata: JSON.stringify(params.metadata ?? {}),
        })
        .returning(['sequence', 'created_at'])
        .executeTakeFirstOrThrow();

      await trx
        .updateTable('capere.ai_sessions')
        .set({ last_message_at: row.created_at })
        .where('id', '=', params.sessionId)
        .execute();

      return {
        role: params.role,
        content: params.content,
        sequence: row.sequence,
        toolCallId: params.toolCallId,
        toolName: params.toolName,
        toolArguments: params.toolArguments,
        metadata: params.metadata,
        createdAt: row.created_at,
      };
    });
  }

  // --- Business ------------------------------------------------------------

  async all(organizationId: string): Promise<BusinessFact[]> {
    const rows = await this.database.db
      .selectFrom('capere.business_memory')
      .select(['key', 'value', 'source', 'confidence', 'updated_at'])
      .where('organization_id', '=', organizationId)
      .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', new Date())]))
      .orderBy('key')
      .execute();

    return rows.map((row) => ({
      key: row.key,
      value: row.value,
      source: row.source,
      confidence: row.confidence ? Number(row.confidence) : undefined,
      updatedAt: row.updated_at,
    }));
  }

  async get(organizationId: string, key: string): Promise<BusinessFact | undefined> {
    const row = await this.database.db
      .selectFrom('capere.business_memory')
      .select(['key', 'value', 'source', 'confidence', 'updated_at'])
      .where('organization_id', '=', organizationId)
      .where('key', '=', key)
      .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', new Date())]))
      .executeTakeFirst();

    if (!row) return undefined;

    return {
      key: row.key,
      value: row.value,
      source: row.source,
      confidence: row.confidence ? Number(row.confidence) : undefined,
      updatedAt: row.updated_at,
    };
  }

  async set(params: {
    organizationId: string;
    key: string;
    value: unknown;
    source?: string;
    confidence?: number;
    expiresAt?: Date;
  }): Promise<void> {
    await this.database.db
      .insertInto('capere.business_memory')
      .values({
        organization_id: params.organizationId,
        key: params.key,
        value: JSON.stringify(params.value),
        source: params.source ?? 'user',
        confidence: params.confidence !== undefined ? String(params.confidence) : null,
        expires_at: params.expiresAt ?? null,
      })
      .onConflict((oc) =>
        oc.columns(['organization_id', 'key']).doUpdateSet({
          value: JSON.stringify(params.value),
          source: params.source ?? 'user',
          confidence: params.confidence !== undefined ? String(params.confidence) : null,
          expires_at: params.expiresAt ?? null,
          updated_at: new Date(),
        }),
      )
      .execute();
  }

  async forget(organizationId: string, key: string): Promise<void> {
    await this.database.db
      .deleteFrom('capere.business_memory')
      .where('organization_id', '=', organizationId)
      .where('key', '=', key)
      .execute();
  }

  // --- Facade --------------------------------------------------------------

  /** A fresh scratchpad for one orchestration run. */
  createWorkingMemory(): WorkingMemory {
    return new InMemoryWorkingMemory();
  }

  /**
   * Creates a session and returns its id.
   *
   * Lives here rather than in the orchestrator because sessions ARE conversation
   * memory — putting it elsewhere would mean reaching into this service's
   * database handle from outside, which is exactly the coupling the facade
   * exists to prevent.
   */
  async createSession(params: {
    organizationId: string;
    userId?: string;
    agent: string;
    title?: string;
  }): Promise<string> {
    const row = await this.database.db
      .insertInto('capere.ai_sessions')
      .values({
        organization_id: params.organizationId,
        user_id: params.userId ?? null,
        agent: params.agent as never,
        title: params.title ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    return row.id;
  }

  private record(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value as Record<string, unknown>;
    if (typeof value === 'string') {
      try {
        const parsed: unknown = JSON.parse(value);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
          return parsed as Record<string, unknown>;
      } catch {}
    }
    return {};
  }

  /**
   * Assembles all four layers for one run.
   *
   * Conversation and business load concurrently. Semantic search is skipped
   * entirely when no query is supplied or no vector store is bound — there is
   * no point paying for a retrieval round trip that cannot return anything.
   */
  async snapshot(params: {
    organizationId: string;
    sessionId?: string;
    semanticQuery?: string;
    conversationLimit?: number;
    semanticLimit?: number;
    working?: WorkingMemory;
  }): Promise<MemorySnapshot> {
    const [conversation, business, semanticResult] = await Promise.all([
      params.sessionId
        ? this.recent(params.organizationId, params.sessionId, params.conversationLimit)
        : Promise.resolve([]),
      this.all(params.organizationId),
      params.semanticQuery && this.semanticStore.available
        ? this.semanticStore
            .search({
              organizationId: params.organizationId,
              query: params.semanticQuery,
              limit: params.semanticLimit ?? 5,
            })
            .then((hits) => ({ hits, available: true }))
            .catch((error: unknown) => {
              // A vector store outage must degrade the answer, not fail the
              // request — the model can still work from conversation and
              // business context.
              //
              // `available: false` here is load-bearing: it is what makes the
              // context builder tell the model the knowledge base was NOT
              // consulted. Reporting `true` after a failed search would invite
              // a confident answer from priors dressed up as a grounded one.
              this.logger.warn(
                `Semantic search failed, continuing without it: ` +
                  `${error instanceof Error ? error.message : String(error)}`,
              );
              return { hits: [], available: false };
            })
        : // No query, or no vector store configured. `available: false` when
          // unconfigured; when configured but unqueried, nothing was searched,
          // so claiming availability would still be a lie by omission.
          Promise.resolve({ hits: [], available: false }),
    ]);

    return {
      conversation,
      business,
      semantic: semanticResult.hits,
      semanticAvailable: semanticResult.available,
      working: params.working?.snapshot() ?? {},
    };
  }
}
