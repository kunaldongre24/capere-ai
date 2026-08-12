import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AutomationService } from '../automation';
import { DatabaseService } from '../shared/database';
import { InsightsEngine } from '../insights';
import { RecommendationService } from '../recommendations';
import { ContentGenerationService, DashboardService } from '../reporting';
import { JOB_DISPATCHER, type JobDispatcher } from './job-dispatcher.service';

export const SCHEDULE_INTERVALS = {
  hourly: 3_600_000,
  daily: 86_400_000,
  weekly: 604_800_000,
  monthly: 2_592_000_000,
} as const;

export type ScheduleKind = keyof typeof SCHEDULE_INTERVALS;

interface ClaimedRun {
  runId: string;
  organizationId: string | null;
  jobType: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);
  private running = false;
  private timer?: NodeJS.Timeout;
  private wake?: () => void;
  private loopPromise?: Promise<void>;
  private readonly workerId = randomUUID();

  private static readonly POLL_INTERVAL_MS = 30_000;
  private static readonly LEASE_MS = 5 * 60_000;
  private static readonly MAX_BATCH_SIZE = 20;

  constructor(
    private readonly database: DatabaseService,
    private readonly insights: InsightsEngine,
    @Optional() @Inject(JOB_DISPATCHER) private readonly dispatcher?: JobDispatcher,
    @Optional() private readonly recommendations?: RecommendationService,
    @Optional() private readonly dashboards?: DashboardService,
    @Optional() private readonly automation?: AutomationService,
    @Optional() private readonly content?: ContentGenerationService,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.logger.log('Scheduler started');
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loopPromise;
    this.loopPromise = undefined;
    this.logger.log('Scheduler stopped');
  }

  async tick(): Promise<number> {
    const retries = await this.claimRetries();
    const remaining = Math.max(0, SchedulerService.MAX_BATCH_SIZE - retries.length);
    const due = remaining > 0 ? await this.claimDue(remaining) : [];
    const runs = [...retries, ...due];

    for (const run of runs) {
      await this.execute(run);
    }

    return runs.length;
  }

  private async claimDue(limit: number): Promise<ClaimedRun[]> {
    return this.database.transaction(async (trx) => {
      const now = new Date();
      const leaseUntil = new Date(now.getTime() + SchedulerService.LEASE_MS);
      const rows = await trx
        .selectFrom('capere.scheduled_jobs')
        .select(['id', 'organization_id', 'job_type', 'schedule', 'payload'])
        .where('enabled', '=', true)
        .where((eb) => eb.or([eb('next_run_at', 'is', null), eb('next_run_at', '<=', now)]))
        .orderBy('next_run_at', 'asc')
        .limit(limit)
        .forUpdate()
        .skipLocked()
        .execute();

      const claimed: ClaimedRun[] = [];
      for (const row of rows) {
        const run = await trx
          .insertInto('capere.job_runs')
          .values({
            organization_id: row.organization_id,
            scheduled_job_id: row.id,
            job_type: row.job_type,
            status: 'running',
            payload: JSON.stringify(row.payload ?? {}),
            attempts: 1,
            max_attempts: 3,
            claimed_by: this.workerId,
            lease_until: leaseUntil,
            started_at: now,
          })
          .returning(['id', 'attempts', 'max_attempts'])
          .executeTakeFirstOrThrow();

        await trx
          .updateTable('capere.scheduled_jobs')
          .set({ last_run_at: now, next_run_at: this.nextRunAt(row.schedule, now) })
          .where('id', '=', row.id)
          .execute();

        claimed.push({
          runId: run.id,
          organizationId: row.organization_id,
          jobType: row.job_type,
          payload: row.payload,
          attempts: run.attempts,
          maxAttempts: run.max_attempts,
        });
      }

      return claimed;
    });
  }

  private async claimRetries(): Promise<ClaimedRun[]> {
    return this.database.transaction(async (trx) => {
      const now = new Date();
      const leaseUntil = new Date(now.getTime() + SchedulerService.LEASE_MS);

      await trx
        .updateTable('capere.job_runs')
        .set({
          status: 'dead_lettered',
          finished_at: now,
          lease_until: null,
          claimed_by: null,
          next_retry_at: null,
          error: 'Worker lease expired after the final permitted attempt',
        })
        .where('status', '=', 'running')
        .where('lease_until', '<=', now)
        .where((eb) => eb('attempts', '>=', eb.ref('max_attempts')))
        .execute();

      const rows = await trx
        .selectFrom('capere.job_runs')
        .select(['id', 'organization_id', 'job_type', 'payload', 'attempts', 'max_attempts'])
        .where((eb) =>
          eb.or([
            eb.and([eb('status', '=', 'failed'), eb('next_retry_at', '<=', now)]),
            eb.and([eb('status', '=', 'running'), eb('lease_until', '<=', now)]),
          ]),
        )
        .where((eb) => eb('attempts', '<', eb.ref('max_attempts')))
        .orderBy('created_at', 'asc')
        .limit(SchedulerService.MAX_BATCH_SIZE)
        .forUpdate()
        .skipLocked()
        .execute();

      const claimed: ClaimedRun[] = [];
      for (const row of rows) {
        const updated = await trx
          .updateTable('capere.job_runs')
          .set((eb) => ({
            status: 'running',
            attempts: eb('attempts', '+', 1),
            claimed_by: this.workerId,
            lease_until: leaseUntil,
            next_retry_at: null,
            started_at: now,
            finished_at: null,
          }))
          .where('id', '=', row.id)
          .returning(['attempts', 'max_attempts'])
          .executeTakeFirstOrThrow();

        claimed.push({
          runId: row.id,
          organizationId: row.organization_id,
          jobType: row.job_type,
          payload: row.payload,
          attempts: updated.attempts,
          maxAttempts: updated.max_attempts,
        });
      }

      return claimed;
    });
  }

  private async execute(run: ClaimedRun): Promise<void> {
    try {
      const result = await this.dispatch(run.jobType, run.organizationId, run.payload);
      await this.database.db
        .updateTable('capere.job_runs')
        .set({
          status: 'succeeded',
          finished_at: new Date(),
          lease_until: null,
          claimed_by: null,
          result: JSON.stringify(result),
        })
        .where('id', '=', run.runId)
        .where('claimed_by', '=', this.workerId)
        .execute();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const terminal = run.attempts >= run.maxAttempts;
      const retryAt = new Date(Date.now() + Math.min(3_600_000, 1_000 * 2 ** run.attempts));
      await this.database.db
        .updateTable('capere.job_runs')
        .set({
          status: terminal ? 'dead_lettered' : 'failed',
          finished_at: new Date(),
          lease_until: null,
          claimed_by: null,
          next_retry_at: terminal ? null : retryAt,
          error: message.slice(0, 2_000),
        })
        .where('id', '=', run.runId)
        .where('claimed_by', '=', this.workerId)
        .execute();
      this.logger.error(`Scheduled job "${run.jobType}" failed: ${message}`);
    }
  }

  private async dispatch(
    jobType: string,
    organizationId: string | null,
    payload: unknown,
  ): Promise<unknown> {
    if (jobType === 'insights-sweep') {
      if (!organizationId) throw new Error('insights-sweep requires an organization');
      return { insightsGenerated: await this.insights.runAll(organizationId) };
    }
    if (jobType === 'recommendation-sweep') {
      if (!organizationId) throw new Error('recommendation-sweep requires an organization');
      if (!this.recommendations) throw new Error('Recommendation service is unavailable');
      return {
        recommendationsGenerated: await this.recommendations.generateFromInsights(organizationId),
      };
    }
    if (jobType === 'dashboard-refresh') {
      if (!organizationId) throw new Error('dashboard-refresh requires an organization');
      if (!this.dashboards) throw new Error('Dashboard service is unavailable');
      return { metricsGenerated: await this.dashboards.refresh(organizationId) };
    }
    if (jobType === 'weekly-report') {
      if (!organizationId) throw new Error('weekly-report requires an organization');
      if (!this.dashboards) throw new Error('Dashboard service is unavailable');
      return { reportId: (await this.dashboards.generateExecutiveReport(organizationId)).id };
    }
    if (jobType === 'daily-brief') {
      if (!organizationId) throw new Error('daily-brief requires an organization');
      if (!this.dashboards) throw new Error('Dashboard service is unavailable');
      return { artifactId: (await this.dashboards.generateDailyBrief(organizationId)).id };
    }
    if (jobType === 'content-generate') {
      if (!organizationId) throw new Error('content-generate requires an organization');
      if (!this.content) throw new Error('Content service is unavailable');
      return { artifactId: (await this.content.generate(organizationId)).id };
    }
    if (jobType === 'automation-execute') {
      if (!organizationId) throw new Error('automation-execute requires an organization');
      if (!this.automation) throw new Error('Automation service is unavailable');
      const actionId = this.objectPayload(payload)['actionId'];
      if (typeof actionId !== 'string')
        throw new Error('automation-execute requires payload.actionId');
      return this.automation.executeApproved(organizationId, actionId);
    }
    if (jobType === 'google-sync') {
      if (!organizationId) throw new Error('google-sync requires an organization');
      const value = this.objectPayload(payload);
      const integrationId = value['integrationId'];
      if (typeof integrationId !== 'string')
        throw new Error('google-sync requires payload.integrationId');
      // A scheduled run must receive a fresh BullMQ id. Reusing a daily id
      // collides with retained completed jobs and silently suppresses later
      // runs on the same day.
      const dispatchId = `google-sync-${organizationId}-${integrationId}-${Date.now()}`;
      const jobId = await this.requireDispatcher().dispatch(
        {
          kind: 'google-sync',
          organizationId,
          integrationId,
        },
        dispatchId,
      );
      return { queuedJobId: jobId };
    }
    if (jobType === 'dataforseo-audit-poll') {
      if (!organizationId) throw new Error('dataforseo-audit-poll requires an organization');
      const value = this.objectPayload(payload);
      const taskId = value['taskId'];
      if (typeof taskId !== 'string')
        throw new Error('dataforseo-audit-poll requires payload.taskId');
      const jobId = await this.requireDispatcher().dispatch(
        {
          kind: 'dataforseo-audit-poll',
          organizationId,
          taskId,
        },
        // Polls are recurring until the provider reports completion; each poll
        // therefore needs a distinct id while the task remains in flight.
        `dataforseo-audit-poll-${taskId}-${Date.now()}`,
      );
      return { queuedJobId: jobId };
    }
    if (jobType === 'dataforseo-audit-submit') {
      if (!organizationId) throw new Error('dataforseo-audit-submit requires an organization');
      const value = this.objectPayload(payload);
      const projectId = value['projectId'];
      const maxCrawlPages = value['maxCrawlPages'];
      if (typeof projectId !== 'string')
        throw new Error('dataforseo-audit-submit requires payload.projectId');
      const jobId = await this.requireDispatcher().dispatch(
        {
          kind: 'dataforseo-audit-submit',
          organizationId,
          projectId,
          maxCrawlPages: typeof maxCrawlPages === 'number' ? Math.min(maxCrawlPages, 20) : 20,
        },
        `dataforseo-audit-submit-${organizationId}-${projectId}-${Date.now()}`,
      );
      return { queuedJobId: jobId };
    }
    if (jobType === 'dataforseo-competitor-refresh') {
      if (!organizationId) throw new Error('dataforseo-competitor-refresh requires an organization');
      const projectId = this.objectPayload(payload)['projectId'];
      if (typeof projectId !== 'string') throw new Error('dataforseo-competitor-refresh requires payload.projectId');
      const jobId = await this.requireDispatcher().dispatch({ kind: 'dataforseo-competitor-refresh', organizationId, projectId }, `dataforseo-competitor-refresh-${organizationId}-${projectId}-${Date.now()}`);
      return { queuedJobId: jobId };
    }
    if (jobType === 'dataforseo-keyword-refresh') {
      if (!organizationId) throw new Error('dataforseo-keyword-refresh requires an organization');
      const value = this.objectPayload(payload);
      const projectId = value['projectId'];
      if (typeof projectId !== 'string') throw new Error('dataforseo-keyword-refresh requires payload.projectId');
      const jobId = await this.requireDispatcher().dispatch({ kind:'dataforseo-keyword-refresh',organizationId,projectId,force:value['force'] === true }, `dataforseo-keyword-refresh-${organizationId}-${projectId}-${Date.now()}`);
      return { queuedJobId: jobId };
    }
    if (jobType === 'github-change-execute') {
      if (!organizationId) throw new Error('github-change-execute requires an organization');
      const value = this.objectPayload(payload);
      const requestId = value['requestId'];
      if (typeof requestId !== 'string')
        throw new Error('github-change-execute requires payload.requestId');
      const jobId = await this.requireDispatcher().dispatch(
        { kind: 'github-change-execute', organizationId, requestId },
        `github-change-execute-${requestId}-${Date.now()}`,
      );
      return { queuedJobId: jobId };
    }
    throw new Error(`No handler registered for job type "${jobType}".`);
  }

  private objectPayload(payload: unknown): Record<string, unknown> {
    if (typeof payload === 'string') {
      try {
        return JSON.parse(payload) as Record<string, unknown>;
      } catch {
        return {};
      }
    }
    return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  }

  private requireDispatcher(): JobDispatcher {
    if (!this.dispatcher) throw new Error('Job dispatcher is unavailable');
    return this.dispatcher;
  }

  nextRunAt(schedule: string, from: Date): Date {
    const interval = SCHEDULE_INTERVALS[schedule as ScheduleKind];
    if (interval) return new Date(from.getTime() + interval);
    if (/^(\S+\s+){4}\S+$/.test(schedule.trim())) {
      throw new Error(`Cron expression "${schedule}" is not supported yet.`);
    }
    throw new Error(
      `Unrecognized schedule "${schedule}". Use hourly|daily|weekly|monthly or a cron expression.`,
    );
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.tick();
      } catch (error) {
        this.logger.error(
          `Scheduler pass failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await new Promise<void>((resolve) => {
        this.wake = () => {
          if (this.timer) clearTimeout(this.timer);
          this.timer = undefined;
          this.wake = undefined;
          resolve();
        };
        this.timer = setTimeout(this.wake, SchedulerService.POLL_INTERVAL_MS);
      });
    }
  }
}
