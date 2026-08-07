import 'reflect-metadata';
import * as path from 'node:path';
import * as dotenv from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import {
  IntegrationJobWorker,
  OutboxRelayWorker,
  QueueRegistryService,
  SchedulerService,
} from './jobs';
import { RagIngestionWorker } from './rag/rag-ingestion.worker';
import { APP_CONFIG, type AppConfig } from './shared/config';

// See main.ts: load .env before config is read; real env vars take precedence.
dotenv.config({ path: path.resolve(__dirname, '../../.env'), override: false });

/**
 * Worker entrypoint.
 *
 * Boots the SAME NestJS module graph as the API but without the HTTP layer, so
 * jobs reuse the exact services the API uses — one definition of intelligence,
 * insights engine, and the database clients, not a parallel copy that drifts.
 *
 * Run alongside the API:
 *   pnpm start        # HTTP
 *   pnpm start:worker # this
 *
 * Separating them keeps the relay's concurrency an explicit operational
 * decision rather than a side effect of how many API replicas happen to exist.
 */
async function bootstrap(): Promise<void> {
  // createApplicationContext, not create(): no HTTP server, no port binding.
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });

  app.useLogger(app.get(Logger));
  const logger = app.get(Logger);
  const config = app.get<AppConfig>(APP_CONFIG);

  const queues = app.get(QueueRegistryService);
  const relay = app.get(OutboxRelayWorker);
  const scheduler = app.get(SchedulerService);
  const ragIngestion = app.get(RagIngestionWorker);
  const integrationJobs = app.get(IntegrationJobWorker);

  await queues.initialize();
  relay.start();
  scheduler.start();
  ragIngestion.start();
  integrationJobs.start();

  logger.log(`Capere worker started (${config.env})`);
  logger.log('  outbox relay:  running');
  logger.log('  scheduler:     running');
  logger.log('  RAG ingestion: running');
  logger.log('  integrations:   running');
  if (!config.openRouter.enabled) {
    logger.warn('OPENROUTER_API_KEY is unset — jobs will use the deterministic fake provider.');
  }

  // Graceful shutdown: stop claiming new work, finish what is in flight, then
  // close connections. Without this, a deploy could interrupt a job mid-write.
  const shutdown = async (signal: string): Promise<void> => {
    logger.log(`Received ${signal}, shutting down worker...`);
    try {
      await ragIngestion.stop();
      await integrationJobs.stop();
      await scheduler.stop();
      await relay.stop();
      await queues.close();
      await app.close();
      logger.log('Worker stopped cleanly');
      process.exit(0);
    } catch (error) {
      logger.error(
        `Error during shutdown: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFailed to start the Capere worker:\n${message}\n`);
  process.exit(1);
});
