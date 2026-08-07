import { Global, Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { APP_CONFIG, type AppConfig } from '../shared/config';
import { DatabaseService } from '../shared/database';
import { SEMANTIC_MEMORY } from '../intelligence/memory/memory.interface';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from './embedding.port';
import { FakeEmbeddingProvider } from './fake-embedding.provider';
import { OpenRouterEmbeddingProvider } from './openrouter-embedding.provider';
import { QdrantVectorStore } from './qdrant-vector.store';
import { PgVectorStore } from './pgvector-vector.store';
import { RagController } from './rag.controller';
import { RagIngestionWorker } from './rag-ingestion.worker';
import { RagService } from './rag.service';
import { SOURCE_STORAGE } from './source-storage';
import { SupabaseSourceStorage } from './source-storage';
import { VECTOR_STORE, type VectorStore } from './vector-store.port';
import { VectorSemanticMemory } from './vector-semantic.memory';

@Global()
@Module({
  imports: [
    MulterModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        limits: { fileSize: config.rag.storage.maxBytes, files: 1, fields: 10 },
      }),
    }),
  ],
  controllers: [RagController],
  providers: [
    {
      provide: EMBEDDING_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): EmbeddingProvider => {
        if (config.openRouter.enabled) return new OpenRouterEmbeddingProvider(config);
        if (config.isProduction) {
          throw new Error(
            'OPENROUTER_API_KEY must be set in production; refusing to bind the fake embedding provider.',
          );
        }
        return new FakeEmbeddingProvider(config.rag.embeddingDimensions);
      },
    },
    {
      provide: VECTOR_STORE,
      inject: [APP_CONFIG, DatabaseService],
      useFactory: (config: AppConfig, database: DatabaseService): VectorStore =>
        config.vectorStore.provider === 'qdrant'
          ? new QdrantVectorStore(config)
          : new PgVectorStore(database, config),
    },
    {
      provide: SOURCE_STORAGE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): SupabaseSourceStorage => new SupabaseSourceStorage(config),
    },
    VectorSemanticMemory,
    RagService,
    RagIngestionWorker,
    {
      provide: SEMANTIC_MEMORY,
      useExisting: VectorSemanticMemory,
    },
  ],
  exports: [
    EMBEDDING_PROVIDER,
    VECTOR_STORE,
    SOURCE_STORAGE,
    SEMANTIC_MEMORY,
    RagService,
    RagIngestionWorker,
  ],
})
export class RagModule {}
