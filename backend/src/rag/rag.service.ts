import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Selectable } from 'kysely';
import type { Transaction } from 'kysely';
import { APP_CONFIG, type AppConfig } from '../shared/config';
import { DatabaseService, type Database, type RagDocumentsTable } from '../shared/database';
import { AppException, ErrorCode } from '../shared/http';
import { chunkText, normalizeSourceText } from './chunking';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from './embedding.port';
import type { CreateRagDocumentDto, ListRagDocumentsDto, UploadedSourceFile } from './rag.dto';
import { SOURCE_STORAGE, storagePath, type SourceStorage } from './source-storage';
import { stablePointId, VECTOR_STORE, type VectorStore } from './vector-store.port';

export type RagDocument = Selectable<RagDocumentsTable>;
export interface RagLease {
  readonly jobId: string;
  readonly claimToken: string;
  readonly assert: () => Promise<void>;
}

export class RagLeaseLostError extends Error {
  constructor(jobId: string) {
    super(`RAG job ${jobId} lease is no longer owned by this worker`);
    this.name = 'RagLeaseLostError';
  }
}

/**
 * Chunk id derived from (versionId, sequence), formatted as a v5-shaped UUID.
 *
 * WHY DETERMINISTIC, not `randomUUID()`:
 *
 * `stablePointId()` maps a chunk id straight to a vector point id. With random
 * ids, re-ingesting a version deletes and re-inserts the `rag_chunks` rows with
 * BRAND NEW ids — so the upsert writes a fresh set of vector points and the
 * previous run's points are neither overwritten nor deleted. They linger,
 * carrying a `chunk_id` payload that no longer matches any row, and because
 * search reads `content` directly from the payload, retrieval can cite text
 * that was removed from the source document.
 *
 * Deterministic ids make chunk n of a version map to the same point every time,
 * so a re-ingest overwrites in place. (Shrinking documents still need an
 * explicit delete — see `ingest()`.)
 */
function deterministicChunkId(versionId: string, sequence: number): string {
  const hex = createHash('sha256').update(`${versionId}:${sequence}`).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

@Injectable()
export class RagService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SOURCE_STORAGE) private readonly storage: SourceStorage,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider,
    @Inject(VECTOR_STORE) private readonly vectors: VectorStore,
  ) {}

  async create(params: {
    userId: string;
    organizationId: string;
    dto: CreateRagDocumentDto;
    file: UploadedSourceFile;
  }): Promise<RagDocument> {
    this.validateFile(params.file);
    const documentId = randomUUID();
    const versionId = randomUUID();
    const organizationId = params.dto.visibility === 'tenant' ? params.organizationId : null;
    const path = storagePath({
      documentId,
      versionId,
      filename: params.file.originalname,
      organizationId,
    });
    const checksum = createHash('sha256').update(params.file.buffer).digest('hex');
    await this.storage.put(path, params.file.buffer, params.file.mimetype);

    try {
      return await this.database.withUserContext(params.userId, async (trx) => {
        const document = await trx
          .insertInto('capere.rag_documents')
          .values({
            id: documentId,
            organization_id: organizationId,
            visibility: params.dto.visibility,
            title: params.dto.title.trim(),
            description: params.dto.description?.trim() || null,
            source_filename: params.file.originalname,
            source_mime_type: params.file.mimetype,
            source_bytes: String(params.file.size),
            storage_path: path,
            source_checksum: checksum,
            created_by: params.userId,
            updated_by: params.userId,
            active_version_id: null,
            error_message: null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('capere.rag_document_versions')
          .values({
            id: versionId,
            document_id: documentId,
            version_number: 1,
            source_checksum: checksum,
            parser_fingerprint: 'text-v1',
            chunker_fingerprint: `characters-v1:${this.config.rag.chunkSize}:${this.config.rag.chunkOverlap}`,
            embedding_fingerprint: `${this.config.rag.embeddingModel}:${this.config.rag.embeddingDimensions}`,
            error_message: null,
          })
          .execute();
        await trx
          .insertInto('capere.rag_ingestion_jobs')
          .values({
            organization_id: organizationId,
            document_id: documentId,
            version_id: versionId,
            operation: 'ingest',
            idempotency_key: versionId,
            next_retry_at: new Date(),
            lease_until: null,
            claimed_by: null,
            error_message: null,
          })
          .execute();
        return document;
      });
    } catch (error) {
      await this.storage.remove(path).catch(() => undefined);
      throw error;
    }
  }

  async list(params: {
    userId: string;
    organizationId: string;
    query: ListRagDocumentsDto;
  }): Promise<RagDocument[]> {
    return this.database.withUserContext(params.userId, async (trx) => {
      let query = trx
        .selectFrom('capere.rag_documents')
        .selectAll()
        .where((eb) =>
          eb.or([
            eb('visibility', '=', 'shared'),
            eb.and([
              eb('visibility', '=', 'tenant'),
              eb('organization_id', '=', params.organizationId),
            ]),
          ]),
        )
        .where('status', '!=', 'deleted')
        .limit(params.query.limit)
        .offset(params.query.offset)
        .orderBy('created_at', 'desc');
      if (params.query.visibility) query = query.where('visibility', '=', params.query.visibility);
      if (params.query.status) query = query.where('status', '=', params.query.status);
      return query.execute();
    });
  }

  async get(userId: string, organizationId: string, documentId: string): Promise<RagDocument> {
    const document = await this.database.withUserContext(userId, (trx) =>
      trx
        .selectFrom('capere.rag_documents')
        .selectAll()
        .where('id', '=', documentId)
        .where((eb) =>
          eb.or([
            eb('visibility', '=', 'shared'),
            eb.and([eb('visibility', '=', 'tenant'), eb('organization_id', '=', organizationId)]),
          ]),
        )
        .executeTakeFirst(),
    );
    if (!document) throw AppException.notFound(ErrorCode.NOT_FOUND, 'RAG document not found');
    return document;
  }

  async ingest(documentId: string, versionId: string, lease: RagLease): Promise<void> {
    await lease.assert();
    const document = await this.database.db
      .selectFrom('capere.rag_documents')
      .selectAll()
      .where('id', '=', documentId)
      .executeTakeFirstOrThrow();
    const bytes = await this.storage.get(document.storage_path);
    if (document.source_mime_type === 'application/pdf') {
      throw new Error('PDF extraction is not configured in this deployment');
    }
    const content = normalizeSourceText(
      Buffer.from(bytes).toString('utf8'),
      document.source_mime_type,
    );
    const chunks = chunkText(content, {
      targetCharacters: this.config.rag.chunkSize,
      overlapCharacters: this.config.rag.chunkOverlap,
      maxChunks: this.config.rag.maxChunksPerDocument,
    });
    if (chunks.length === 0) throw new Error('Source document contains no indexable text');

    const embeddingResults: number[][] = [];
    for (let index = 0; index < chunks.length; index += this.config.rag.embeddingBatchSize) {
      await lease.assert();
      const batch = chunks.slice(index, index + this.config.rag.embeddingBatchSize);
      const result = await this.embeddings.embed(batch.map((chunk) => chunk.content));
      embeddingResults.push(...result.vectors.map((vector) => [...vector]));
    }
    await this.vectors.ensureCollection(this.config.rag.embeddingDimensions);

    await lease.assert();
    const storedChunks = await this.database.transaction(async (trx) => {
      await this.lockLease(trx, lease);
      await trx.deleteFrom('capere.rag_chunks').where('version_id', '=', versionId).execute();
      return trx
        .insertInto('capere.rag_chunks')
        .values(
          chunks.map((chunk) => ({
            // Deterministic, so re-ingesting this version overwrites the same
            // vector points instead of orphaning the previous run's.
            id: deterministicChunkId(versionId, chunk.sequence),
            version_id: versionId,
            sequence: chunk.sequence,
            content: chunk.content,
            content_checksum: chunk.contentChecksum,
            character_count: chunk.characterCount,
            token_count: Math.ceil(chunk.characterCount / 4),
            section: chunk.section ?? null,
            page_number: null,
            source_start: chunk.sourceStart,
            source_end: chunk.sourceEnd,
          })),
        )
        .returningAll()
        .execute();
    });

    // Clear the previous run's vectors BEFORE upserting. Deterministic ids mean
    // chunks 0..n-1 are overwritten in place, but if this run produced fewer
    // chunks than the last one, the tail points would survive and keep serving
    // text that is no longer in the document.
    await lease.assert();
    await this.vectors.deleteVersion(versionId);

    await lease.assert();
    await this.vectors.upsert(
      storedChunks.map((chunk, index) => ({
        pointId: stablePointId(chunk.id),
        vector: embeddingResults[index] ?? [],
        payload: {
          documentId,
          versionId,
          chunkId: chunk.id,
          visibility: document.visibility,
          organizationId: document.organization_id,
          title: document.title,
          source: document.source_filename,
          section: chunk.section ?? undefined,
          content: chunk.content,
          checksum: chunk.content_checksum,
        },
      })),
      lease.assert,
    );

    await lease.assert();
    await this.database.transaction(async (trx) => {
      await this.lockLease(trx, lease);
      await trx
        .updateTable('capere.rag_document_versions')
        .set({ status: 'indexed', chunk_count: storedChunks.length, error_message: null })
        .where('id', '=', versionId)
        .execute();
      await trx
        .updateTable('capere.rag_documents')
        .set({ status: 'indexed', active_version_id: versionId, error_message: null })
        .where('id', '=', documentId)
        .execute();
    });
  }

  /**
   * Purges a document's CONTENT while retaining its metadata row.
   *
   * Soft delete, following the schema's own design: `rag_document_status`
   * includes 'deleted' and `list()` filters on it, so the row is meant to
   * survive as an audit record of who uploaded what and when. What must
   * genuinely go is the content — vectors, the stored source file, and the chunk
   * text.
   *
   * ORDER MATTERS for external vector adapters. Vectors are removed first so a
   * provider failure leaves the canonical chunks available for a retry instead
   * of leaving an untraceable remote index entry. Pgvector also has cascading
   * foreign keys, but follows the same ordering so every adapter has identical
   * purge semantics.
   */
  async purge(documentId: string, lease: RagLease): Promise<void> {
    await lease.assert();
    const document = await this.database.db
      .selectFrom('capere.rag_documents')
      .select(['storage_path'])
      .where('id', '=', documentId)
      .executeTakeFirst();

    // Already purged, or never existed. Idempotent by design: the worker
    // retries, and a delete job must not dead-letter because it already won.
    if (!document) return;

    await lease.assert();
    await this.vectors.deleteDocument(documentId);

    const versions = await this.database.db
      .selectFrom('capere.rag_document_versions')
      .select('id')
      .where('document_id', '=', documentId)
      .execute();

    await lease.assert();
    await this.database.transaction(async (trx) => {
      await this.lockLease(trx, lease);
      if (versions.length > 0) {
        await trx
          .deleteFrom('capere.rag_chunks')
          .where(
            'version_id',
            'in',
            versions.map((version) => version.id),
          )
          .execute();
      }

      await trx
        .updateTable('capere.rag_document_versions')
        .set({ status: 'superseded', chunk_count: 0 })
        .where('document_id', '=', documentId)
        .execute();

      await trx
        .updateTable('capere.rag_documents')
        .set({ status: 'deleted', active_version_id: null, error_message: null })
        .where('id', '=', documentId)
        .execute();
    });

    // Last, and non-fatal: the row is already marked deleted and the content is
    // unreachable, so a storage hiccup should not fail the job and cause a
    // retry that redoes the work above.
    await this.storage.remove(document.storage_path).catch(() => undefined);
  }

  private async lockLease(trx: Transaction<Database>, lease: RagLease): Promise<void> {
    const row = await trx
      .selectFrom('capere.rag_ingestion_jobs')
      .select('id')
      .where('id', '=', lease.jobId)
      .where('status', '=', 'running')
      .where('claimed_by', '=', lease.claimToken)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new RagLeaseLostError(lease.jobId);
  }

  private validateFile(file: UploadedSourceFile): void {
    if (!file || file.size <= 0 || file.buffer.byteLength <= 0) {
      throw AppException.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'A non-empty source file is required',
      );
    }
    if (file.size > this.config.rag.storage.maxBytes) {
      throw AppException.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Source file exceeds the configured limit',
      );
    }
    if (!this.config.rag.storage.allowedMimeTypes.includes(file.mimetype)) {
      // Naming the supported types matters: PDF is the format CPA playbooks
      // and SOPs most often arrive in, so this rejection will be hit, and a
      // bare "unsupported" gives the user nothing to act on.
      throw AppException.badRequest(
        ErrorCode.VALIDATION_FAILED,
        `Unsupported source MIME type "${file.mimetype}". ` +
          `Supported types: ${this.config.rag.storage.allowedMimeTypes.join(', ')}.` +
          (file.mimetype === 'application/pdf'
            ? ' PDF extraction is not implemented yet — convert to Markdown or plain text.'
            : ''),
      );
    }
  }
}
