import type { SemanticHit } from '../intelligence/memory/memory.interface';

export interface VectorRecord {
  readonly pointId: string;
  readonly vector: readonly number[];
  readonly payload: {
    readonly documentId: string;
    readonly versionId: string;
    readonly chunkId: string;
    readonly visibility: 'shared' | 'tenant';
    readonly organizationId: string | null;
    readonly title: string;
    readonly source?: string;
    readonly section?: string;
    readonly content: string;
    readonly checksum: string;
  };
}

export interface VectorStore {
  /**
   * True when the selected store is configured. Cheap and synchronous.
   *
   * This is NOT a liveness signal — a configured-but-unreachable store still
   * reports `true` here. Use `isReachable()` before telling the model its
   * knowledge base was consulted.
   */
  readonly available: boolean;

  /**
   * True when the store is configured AND actually answering.
   *
   * Result is cached briefly by implementations so callers do not pay a probe
   * per query. This is what `SemanticMemory.available` must be derived from:
   * claiming the playbook was searched when the vector store is down invites
   * the model to answer confidently from priors, which is the exact failure
   * this system cannot afford.
   */
  isReachable(): Promise<boolean>;

  ensureCollection(dimensions: number): Promise<void>;
  upsert(records: readonly VectorRecord[], assertLease?: () => Promise<void>): Promise<void>;
  search(params: {
    organizationId: string;
    vector: readonly number[];
    limit: number;
    minScore?: number;
  }): Promise<SemanticHit[]>;
  deleteDocument(documentId: string): Promise<void>;
  /** Removes every point belonging to one document version. */
  deleteVersion(versionId: string): Promise<void>;
}

export const VECTOR_STORE = Symbol('VECTOR_STORE');

export function stablePointId(chunkId: string): string {
  return chunkId;
}
