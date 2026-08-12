import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../shared/config';
import type { IntegrationJob } from './integration-job.worker';
import { QueueRegistryService } from './queue-registry.service';

export const JOB_DISPATCHER = Symbol('JOB_DISPATCHER');

export interface JobDispatcher {
  dispatch(job: IntegrationJob, idempotencyKey: string, scheduleAt?: Date): Promise<string>;
}

@Injectable()
export class RedisJobDispatcher implements JobDispatcher {
  constructor(private readonly queues: QueueRegistryService) {}

  async dispatch(job: IntegrationJob, idempotencyKey: string): Promise<string> {
    await this.queues.initialize();
    const queued = await this.queues.get('integration-sync').add(job.kind, job, { jobId: idempotencyKey });
    return String(queued.id);
  }
}

@Injectable()
export class CloudTasksJobDispatcher implements JobDispatcher {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async dispatch(job: IntegrationJob, idempotencyKey: string, scheduleAt?: Date): Promise<string> {
    const accessToken = await this.metadataAccessToken();
    const parent = `projects/${this.config.jobs.googleCloudProject}/locations/${this.config.jobs.cloudTasksLocation}/queues/${this.config.jobs.cloudTasksQueue}`;
    const taskId = idempotencyKey.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 500);
    const body = {
      task: {
        name: `${parent}/tasks/${taskId}`,
        ...(scheduleAt ? { scheduleTime: scheduleAt.toISOString() } : {}),
        httpRequest: {
          httpMethod: 'POST',
          url: `${this.config.managedTasks.audience.replace(/\/$/, '')}/api/v1/internal/jobs/integrations/execute`,
          headers: { 'Content-Type': 'application/json' },
          body: Buffer.from(JSON.stringify(job)).toString('base64'),
          oidcToken: {
            serviceAccountEmail: this.config.managedTasks.serviceAccount,
            audience: this.config.managedTasks.audience,
          },
        },
      },
    };
    const response = await fetch(`https://cloudtasks.googleapis.com/v2/${parent}/tasks`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const result = await response.json().catch(() => ({})) as { name?: string; error?: { message?: string } };
    if (!response.ok) {
      if (response.status === 409) return `${parent}/tasks/${taskId}`;
      throw new Error(result.error?.message ?? `Cloud Tasks returned HTTP ${response.status}`);
    }
    return result.name ?? `${parent}/tasks/${taskId}`;
  }

  private async metadataAccessToken(): Promise<string> {
    const response = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(5_000),
    });
    const body = await response.json().catch(() => ({})) as { access_token?: string };
    if (!response.ok || !body.access_token) throw new Error('Could not obtain a Google Cloud service account token');
    return body.access_token;
  }
}
