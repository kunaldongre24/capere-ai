import { Inject, Injectable, Logger } from '@nestjs/common';
import { Queue, type JobsOptions } from 'bullmq';
import { APP_CONFIG, type AppConfig } from '../shared/config';

/**
 * Job queue definitions.
 *
 * Only queues with an active BullMQ consumer are registered. Scheduled
 * reporting, content and insight work currently runs through the PostgreSQL
 * scheduler and must not be advertised as Redis-backed isolation.
 */

export const QUEUES = {
  /** Sync integrations and execute approved provider jobs. */
  'integration-sync': { name: 'capere-integration-sync', attempts: 5 },
} as const;

export type QueueName = keyof typeof QUEUES;

/** Every queue, instantiated against Redis. */
export type QueueRegistry = Record<QueueName, Queue>;

/**
 * A named queue on a shared Redis connection.
 *
 * Creating a Queue in BullMQ is lazy — no Redis traffic until the first job is
 * added — so instantiating all of them at boot is cheap. A shared Redis
 * connection keeps resource usage flat instead of one connection per queue.
 */
@Injectable()
export class QueueRegistryService {
  private readonly logger = new Logger(QueueRegistryService.name);
  private readonly queues = new Map<QueueName, Queue>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /**
   * Opens every queue. Called once at bootstrap.
   */
  async initialize(): Promise<QueueRegistry> {
    if (this.queues.size > 0) return this.all();

    const connection = { url: this.config.redis.url };
    const defaults: JobsOptions = {
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 1000 },
    };

    for (const [name, { attempts }] of Object.entries(QUEUES)) {
      const queue = new Queue(QUEUES[name as QueueName].name, {
        connection,
        defaultJobOptions: {
          ...defaults,
          attempts,
          backoff: { type: 'exponential', delay: 5_000 },
        },
      });
      this.queues.set(name as QueueName, queue);
    }

    try {
      await Promise.all([...this.queues.values()].map((queue) => queue.waitUntilReady()));
    } catch (error) {
      await this.close();
      throw error;
    }

    this.logger.log(`Opened ${this.queues.size} queues`);
    return this.all();
  }

  get(name: QueueName): Queue {
    const queue = this.queues.get(name);
    if (!queue) {
      throw new Error(`Queue "${name}" has not been opened. Call initialize() at bootstrap.`);
    }
    return queue;
  }

  all(): QueueRegistry {
    return Object.fromEntries(this.queues) as QueueRegistry;
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    this.queues.clear();
  }
}
