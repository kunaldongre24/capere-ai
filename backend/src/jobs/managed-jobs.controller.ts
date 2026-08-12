import { timingSafeEqual } from 'node:crypto';
import { Body, Controller, Headers, Inject, Post } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { Public, SkipOrganization } from '../auth';
import { RagIngestionWorker } from '../rag/rag-ingestion.worker';
import { APP_CONFIG, type AppConfig } from '../shared/config';
import { AppException, ErrorCode } from '../shared/http';
import { IntegrationJobWorker, type IntegrationJob } from './integration-job.worker';
import { OutboxRelayWorker } from './outbox-relay.worker';
import { SchedulerService } from './scheduler.service';

@Controller({ path: 'internal/jobs', version: '1' })
@Public()
@SkipOrganization()
export class ManagedJobsController {
  private readonly googleJwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly scheduler: SchedulerService,
    private readonly outbox: OutboxRelayWorker,
    private readonly rag: RagIngestionWorker,
    private readonly integrations: IntegrationJobWorker,
  ) {}

  @Post('scheduler/tick')
  async schedulerTick(@Headers('authorization') authorization?: string, @Headers('x-capere-task-secret') secret?: string) {
    await this.authorize(authorization, secret);
    return { processed: await this.scheduler.tick() };
  }

  @Post('outbox/tick')
  async outboxTick(@Headers('authorization') authorization?: string, @Headers('x-capere-task-secret') secret?: string) {
    await this.authorize(authorization, secret);
    return { processed: await this.outbox.tick() };
  }

  @Post('rag/tick')
  async ragTick(@Headers('authorization') authorization?: string, @Headers('x-capere-task-secret') secret?: string) {
    await this.authorize(authorization, secret);
    return { processed: await this.rag.tick() };
  }

  @Post('integrations/execute')
  async integrationExecute(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-capere-task-secret') secret: string | undefined,
    @Body() job: IntegrationJob,
  ) {
    await this.authorize(authorization, secret);
    return this.integrations.execute(job);
  }

  private async authorize(authorization?: string, candidate?: string): Promise<void> {
    if (authorization?.startsWith('Bearer ') && this.config.managedTasks.audience) {
      try {
        const { payload } = await jwtVerify(authorization.slice(7), this.googleJwks, {
          audience: this.config.managedTasks.audience,
          issuer: ['https://accounts.google.com', 'accounts.google.com'],
        });
        if (payload.email === this.config.managedTasks.serviceAccount && payload.email_verified === true) return;
      } catch {
        // Fall through to the explicit fallback secret below.
      }
    }
    const expected = this.config.managedTaskSecret;
    if (!expected || !candidate) {
      throw AppException.unauthorized(ErrorCode.UNAUTHENTICATED, 'Managed task authentication is required');
    }
    const left = Buffer.from(expected);
    const right = Buffer.from(candidate);
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      throw AppException.unauthorized(ErrorCode.INVALID_TOKEN, 'Managed task authentication failed');
    }
  }
}
