import { Inject, Injectable, Logger } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { DataForSeoService } from '../integrations/dataforseo/dataforseo.service';
import { GoogleSyncService } from '../integrations/google/google-sync.service';
import { GithubService } from '../integrations/github/github.service';
import { APP_CONFIG, type AppConfig } from '../shared/config';
import { QUEUES } from './queue-registry.service';

type IntegrationJob =
  | {
      kind: 'google-sync';
      organizationId: string;
      integrationId: string;
      from?: string;
      to?: string;
    }
  | { kind: 'dataforseo-audit-poll'; organizationId: string; taskId: string }
  | { kind: 'dataforseo-audit-submit'; organizationId: string; projectId: string; maxCrawlPages: number }
  | { kind: 'dataforseo-competitor-refresh'; organizationId: string; projectId: string }
  | { kind: 'dataforseo-keyword-refresh'; organizationId: string; projectId: string; force?: boolean }
  | { kind: 'github-change-execute'; organizationId: string; requestId: string };

@Injectable()
export class IntegrationJobWorker {
  private readonly logger = new Logger(IntegrationJobWorker.name);
  private worker?: Worker<IntegrationJob>;
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly google: GoogleSyncService,
    private readonly dataForSeo: DataForSeoService,
    private readonly github: GithubService,
  ) {}

  start(): void {
    if (this.worker) return;
    this.worker = new Worker<IntegrationJob>(
      QUEUES['integration-sync'].name,
      (job) => this.process(job),
      {
        connection: { url: this.config.redis.url },
        concurrency: 5,
      },
    );
    this.worker.on('failed', (job, error) =>
      this.logger.error(`Integration job ${job?.id ?? 'unknown'} failed: ${error.message}`),
    );
    this.logger.log('Integration job worker started');
  }

  async stop(): Promise<void> {
    await this.worker?.close();
    this.worker = undefined;
  }

  private process(job: Job<IntegrationJob>) {
    if (job.data.kind === 'google-sync')
      return this.google.sync(
        job.data.organizationId,
        job.data.integrationId,
        job.data.from,
        job.data.to,
      );
    if (job.data.kind === 'dataforseo-audit-poll')
      return this.dataForSeo.pollAudit(job.data.organizationId, job.data.taskId);
    if (job.data.kind === 'dataforseo-audit-submit')
      return this.dataForSeo.submitAudit(job.data.organizationId, job.data.projectId, {
        maxCrawlPages: Math.min(job.data.maxCrawlPages, 20),
      });
    if (job.data.kind === 'dataforseo-competitor-refresh')
      return this.dataForSeo.refreshCompetitors(job.data.organizationId, job.data.projectId);
    if (job.data.kind === 'dataforseo-keyword-refresh')
      return this.dataForSeo.refreshKeywords(job.data.organizationId, job.data.projectId, job.data.force === true);
    return this.github.executeApproved(job.data.organizationId, job.data.requestId);
  }
}
