import { Injectable } from '@nestjs/common';
import { sql, type RawBuilder } from 'kysely';
import type { SemanticHit } from '../intelligence/memory/memory.interface';
import { DatabaseService } from '../shared/database';
import type { AppConfig } from '../shared/config';
import type { VectorRecord, VectorStore } from './vector-store.port';

interface PgVectorSearchRow {
  document_id: string;
  chunk_id: string;
  content: string;
  title: string;
  source: string | null;
  section: string | null;
  score: number;
}

@Injectable()
export class PgVectorStore implements VectorStore {
  readonly available = true;

  constructor(
    private readonly database: DatabaseService,
    private readonly config: AppConfig,
  ) {}

  async isReachable(): Promise<boolean> {
    try {
      await sql`SELECT 1 FROM capere.rag_vector_points LIMIT 1`.execute(this.database.db);
      return true;
    } catch {
      return false;
    }
  }

  async ensureCollection(dimensions: number): Promise<void> {
    if (dimensions !== 1536) {
      throw new Error(
        `pgvector is provisioned for 1536 dimensions, but the embedding provider returned ${dimensions}`,
      );
    }
    if (!(await this.isReachable())) {
      throw new Error('pgvector table is not available; apply migration 0018_pgvector_store.sql');
    }
  }

  async upsert(records: readonly VectorRecord[], assertLease?: () => Promise<void>): Promise<void> {
    if (records.length === 0) return;
    await this.ensureCollection(this.config.rag.embeddingDimensions);
    const batchSize = this.config.rag.vectorWriteBatchSize;
    for (let offset = 0; offset < records.length; offset += batchSize) {
      await assertLease?.();
      const batch = records.slice(offset, offset + batchSize);
      await this.database.transaction(async (trx) => {
        for (const record of batch) {
          this.assertDimensions(record.vector);
        }
        await trx
          .insertInto('capere.rag_vector_points')
          .values(
            batch.map((record) => ({
              point_id: record.pointId,
              document_id: record.payload.documentId,
              version_id: record.payload.versionId,
              organization_id: record.payload.organizationId,
              visibility: record.payload.visibility,
              embedding: this.vector(record.vector),
            })),
          )
          .onConflict((conflict) =>
            conflict.column('point_id').doUpdateSet((eb) => ({
              document_id: eb.ref('excluded.document_id'),
              version_id: eb.ref('excluded.version_id'),
              organization_id: eb.ref('excluded.organization_id'),
              visibility: eb.ref('excluded.visibility'),
              embedding: eb.ref('excluded.embedding'),
            })),
          )
          .execute();
      });
    }
  }

  async search(params: {
    organizationId: string;
    vector: readonly number[];
    limit: number;
    minScore?: number;
  }): Promise<SemanticHit[]> {
    this.assertDimensions(params.vector);
    const embedding = this.vector(params.vector);
    const result = await sql<PgVectorSearchRow>`
      WITH ranked AS (
        SELECT
          p.document_id,
          p.point_id AS chunk_id,
          c.content,
          d.title,
          d.source_filename AS source,
          c.section,
          1 - (p.embedding <=> ${embedding}) AS score
        FROM capere.rag_vector_points p
        JOIN capere.rag_chunks c ON c.id = p.point_id
        JOIN capere.rag_documents d ON d.id = p.document_id
        WHERE p.visibility = 'shared'
           OR (p.visibility = 'tenant' AND p.organization_id = ${params.organizationId}::uuid)
        ORDER BY p.embedding <=> ${embedding}
        LIMIT ${Math.max(1, Math.min(params.limit, 100))}
      )
      SELECT * FROM ranked
      WHERE score >= ${params.minScore ?? 0}
      ORDER BY score DESC
    `.execute(this.database.db);

    return result.rows.map((row) => ({
      documentId: row.document_id,
      chunkId: row.chunk_id,
      content: row.content,
      score: Number(row.score),
      citation: {
        title: row.title,
        source: row.source ?? undefined,
        section: row.section ?? undefined,
      },
    }));
  }

  async deleteDocument(documentId: string): Promise<void> {
    await this.database.db
      .deleteFrom('capere.rag_vector_points')
      .where('document_id', '=', documentId)
      .execute();
  }

  async deleteVersion(versionId: string): Promise<void> {
    await this.database.db
      .deleteFrom('capere.rag_vector_points')
      .where('version_id', '=', versionId)
      .execute();
  }

  private vector(values: readonly number[]): RawBuilder<string> {
    return sql<string>`${`[${values.join(',')}]`}::extensions.vector`;
  }

  private assertDimensions(vector: readonly number[]): void {
    if (vector.length !== this.config.rag.embeddingDimensions) {
      throw new Error(
        `Embedding dimension ${vector.length} does not match configured dimension ${this.config.rag.embeddingDimensions}`,
      );
    }
    if (vector.some((value) => !Number.isFinite(value))) {
      throw new Error('Embedding contains a non-finite value');
    }
  }
}
