import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Transaction } from 'kysely';
import { SchedulerService } from '../src/jobs/scheduler.service';
import type { InsightsEngine } from '../src/insights';
import type { Database, DatabaseService } from '../src/shared/database';
import {
  cleanup,
  closeDb,
  seedTwoOrganizations,
  serviceDb,
  type Fixture,
} from './helpers/database';

describe('SchedulerService reliability', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await seedTwoOrganizations();
  });

  beforeEach(async () => {
    // Scheduler claims work globally. Clear all test jobs so another suite's
    // tenant fixture cannot change this service's batch-size assertion.
    await serviceDb().deleteFrom('capere.scheduled_jobs').execute();
  });

  afterAll(async () => {
    await cleanup(fixture);
    await closeDb();
  });

  it('records a successful run and advances the schedule', async () => {
    const runAll = vi.fn().mockResolvedValue(2);
    const scheduler = makeScheduler(runAll);
    const jobId = await insertJob('insights-sweep');

    await expect(scheduler.tick()).resolves.toBe(1);
    expect(runAll).toHaveBeenCalledWith(fixture.orgAId);

    const run = await latestRun(jobId);
    expect(run).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(run?.lease_until).toBeNull();
    expect(run?.claimed_by).toBeNull();

    const job = await serviceDb()
      .selectFrom('capere.scheduled_jobs')
      .select(['last_run_at', 'next_run_at'])
      .where('id', '=', jobId)
      .executeTakeFirstOrThrow();
    expect(job.last_run_at).toBeInstanceOf(Date);
    expect(job.next_run_at!.getTime()).toBeGreaterThan(job.last_run_at!.getTime());
  });

  it('retries failures and dead-letters after the configured maximum', async () => {
    const scheduler = makeScheduler(vi.fn().mockRejectedValue(new Error('generator failed')));
    const jobId = await insertJob('insights-sweep');

    await scheduler.tick();
    let run = await latestRun(jobId);
    expect(run).toMatchObject({ status: 'failed', attempts: 1, max_attempts: 3 });

    for (let attempt = 2; attempt <= 3; attempt += 1) {
      await serviceDb()
        .updateTable('capere.job_runs')
        .set({ next_retry_at: new Date(Date.now() - 1_000) })
        .where('id', '=', run!.id)
        .execute();
      await scheduler.tick();
      run = await latestRun(jobId);
      expect(run?.attempts).toBe(attempt);
    }

    expect(run).toMatchObject({ status: 'dead_lettered', attempts: 3 });
    expect(run?.next_retry_at).toBeNull();
  });

  it('reclaims a stale running lease', async () => {
    const runAll = vi.fn().mockResolvedValue(1);
    const scheduler = makeScheduler(runAll);
    const jobId = await insertJob('insights-sweep', new Date(Date.now() + 3_600_000));
    const stale = await serviceDb()
      .insertInto('capere.job_runs')
      .values({
        organization_id: fixture.orgAId,
        scheduled_job_id: jobId,
        job_type: 'insights-sweep',
        status: 'running',
        attempts: 1,
        max_attempts: 3,
        lease_until: new Date(Date.now() - 1_000),
        claimed_by: crypto.randomUUID(),
        started_at: new Date(Date.now() - 10_000),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await expect(scheduler.tick()).resolves.toBe(1);
    const run = await serviceDb()
      .selectFrom('capere.job_runs')
      .select(['status', 'attempts'])
      .where('id', '=', stale.id)
      .executeTakeFirstOrThrow();
    expect(run).toEqual({ status: 'succeeded', attempts: 2 });
  });

  it('rejects cron expressions until a real parser is implemented', () => {
    const scheduler = makeScheduler(vi.fn());
    expect(() => scheduler.nextRunAt('0 8 * * 1', new Date())).toThrow('not supported');
  });

  function makeScheduler(runAll: ReturnType<typeof vi.fn>): SchedulerService {
    const database = {
      db: serviceDb(),
      transaction: <T>(fn: (trx: Transaction<Database>) => Promise<T>) =>
        serviceDb().transaction().execute(fn),
    } as unknown as DatabaseService;
    return new SchedulerService(database, { runAll } as unknown as InsightsEngine);
  }

  async function insertJob(jobType: string, nextRunAt = new Date(Date.now() - 1_000)) {
    const row = await serviceDb()
      .insertInto('capere.scheduled_jobs')
      .values({
        organization_id: fixture.orgAId,
        job_type: jobType,
        name: `test-${crypto.randomUUID()}`,
        schedule: 'hourly',
        next_run_at: nextRunAt,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  function latestRun(jobId: string) {
    return serviceDb()
      .selectFrom('capere.job_runs')
      .selectAll()
      .where('scheduled_job_id', '=', jobId)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
  }
});
