import { Module } from '@nestjs/common';
import Redis from 'ioredis';
import { sql } from 'kysely';
import { APP_CONFIG, type AppConfig } from '../shared/config';
import { DatabaseService } from '../shared/database';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  controllers: [HealthController],
  providers: [
    HealthService,
    {
      provide: 'HEALTH_DEPENDENCIES',
      inject: [APP_CONFIG, HealthService, DatabaseService],
      useFactory: (config: AppConfig, health: HealthService, database: DatabaseService): void => {
        health.register({
          name: 'redis',
          check: async () => {
            const redis = new Redis(config.redis.url, { lazyConnect: true, connectTimeout: 2_000 });
            try {
              await redis.connect();
              await redis.ping();
              return { status: 'up' };
            } finally {
              await redis.quit().catch(() => redis.disconnect());
            }
          },
        });
        if (config.vectorStore.provider === 'qdrant') {
          health.register({
            name: 'qdrant',
            check: async () => {
              const headers = new Headers();
              if (config.qdrant.apiKey) headers.set('api-key', config.qdrant.apiKey);
              const response = await fetch(`${config.qdrant.url.replace(/\/$/, '')}/healthz`, {
                headers,
                signal: AbortSignal.timeout(config.qdrant.timeoutMs),
              });
              return response.ok
                ? { status: 'up' as const }
                : { status: 'down' as const, error: `HTTP ${response.status}` };
            },
          });
        } else {
          health.register({
            name: 'pgvector',
            check: async () => {
              await sql`SELECT 1 FROM capere.rag_vector_points LIMIT 1`.execute(database.db);
              return { status: 'up' as const };
            },
          });
        }
        if (config.supabase.projectUrl && config.database.serviceRoleKey) {
          health.register({
            name: 'supabase-storage',
            check: async () => {
              const response = await fetch(
                `${config.supabase.projectUrl.replace(/\/$/, '')}/storage/v1/bucket/${config.rag.storage.bucket}`,
                {
                  headers: {
                    authorization: `Bearer ${config.database.serviceRoleKey}`,
                    apikey: config.database.serviceRoleKey,
                  },
                  signal: AbortSignal.timeout(5_000),
                },
              );
              return response.ok
                ? { status: 'up' as const }
                : { status: 'down' as const, error: `HTTP ${response.status}` };
            },
          });
        }
        if (config.openRouter.enabled) {
          health.register({
            name: 'openrouter',
            check: async () => {
              const response = await fetch(
                `${config.openRouter.baseUrl.replace(/\/$/, '')}/models`,
                {
                  headers: { authorization: `Bearer ${config.openRouter.apiKey}` },
                  signal: AbortSignal.timeout(Math.min(config.openRouter.timeoutMs, 10_000)),
                },
              );
              return response.ok
                ? { status: 'up' as const }
                : { status: 'down' as const, error: `HTTP ${response.status}` };
            },
          });
        }
      },
    },
  ],
  exports: [HealthService],
})
export class HealthModule {}
