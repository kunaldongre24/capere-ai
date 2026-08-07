import { Inject, Injectable } from '@nestjs/common';
import type { SemanticHit, SemanticMemory } from '../intelligence/memory/memory.interface';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from './embedding.port';
import { VECTOR_STORE, type VectorStore } from './vector-store.port';

@Injectable()
export class VectorSemanticMemory implements SemanticMemory {
  constructor(
    @Inject(EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider,
    @Inject(VECTOR_STORE) private readonly vectors: VectorStore,
  ) {}

  get available(): boolean {
    return this.vectors.available;
  }

  async isAvailable(): Promise<boolean> {
    return this.vectors.isReachable();
  }

  async search(params: {
    organizationId: string;
    query: string;
    limit?: number;
    minScore?: number;
  }): Promise<SemanticHit[]> {
    if (!this.vectors.available) return [];
    if (!(await this.vectors.isReachable())) {
      throw new Error(
        'The configured vector store is unreachable; semantic retrieval is unavailable.',
      );
    }
    const result = await this.embeddings.embed([params.query]);
    const vector = result.vectors[0];
    if (!vector || vector.length === 0) {
      throw new Error('Embedding provider returned no vector for the query');
    }
    return this.vectors.search({
      organizationId: params.organizationId,
      vector,
      limit: params.limit ?? 8,
      minScore: params.minScore,
    });
  }
}
