import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AutomationService } from '../src/automation';
import { JobMonitoringService } from '../src/jobs/job-monitoring.service';
import { DashboardService } from '../src/reporting';
import { ContentGenerationService } from '../src/reporting/content-generation.service';
import type { ModelRouterService } from '../src/llm';
import type { GhlTokenService } from '../src/integrations/ghl/ghl-token.service';
import { GhlAdapterError, type GhlAdapter } from '../src/integrations/ghl/ghl.adapter';
import type { DatabaseService } from '../src/shared/database';
import {
  cleanup,
  closeDb,
  seedTwoOrganizations,
  serviceDb,
  type Fixture,
} from './helpers/database';

const database = () =>
  ({
    db: serviceDb(),
    transaction: <T>(fn: (trx: unknown) => Promise<T>) =>
      serviceDb()
        .transaction()
        .execute((trx) => fn(trx)),
  }) as unknown as DatabaseService;

describe('Phase 6 approval-first automation', () => {
  let fixture: Fixture;
  let integrationId: string;
  let automation: AutomationService;
  const postJson = vi.fn().mockResolvedValue({ task: { id: 'ghl-task-1' } });
  beforeAll(async () => {
    fixture = await seedTwoOrganizations();
    integrationId = (
      await serviceDb()
        .insertInto('capere.integrations')
        .values({
          organization_id: fixture.orgAId,
          provider: 'go_high_level',
          account_id: 'location-1',
          status: 'connected',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    automation = new AutomationService(
      database(),
      {
        credentials: vi.fn().mockResolvedValue({ accessToken: 'secret' }),
      } as unknown as GhlTokenService,
      { postJson } as unknown as GhlAdapter,
    );
  });
  afterAll(async () => {
    await cleanup(fixture);
    await closeDb();
  });

  it('does not execute before approval and executes the immutable approved payload', async () => {
    const action = await automation.create(fixture.orgAId, fixture.userAId, {
      integrationId,
      kind: 'ghl_task_create',
      title: 'Follow up',
      payload: { contactId: 'contact-1', title: 'Call lead' },
    });
    expect(action.status).toBe('draft');
    expect(postJson).not.toHaveBeenCalled();
    await automation.approve(fixture.orgAId, action.id, fixture.userAId);
    await automation.executeApproved(fixture.orgAId, action.id);
    expect(postJson).toHaveBeenCalledWith(
      { accessToken: 'secret' },
      'contacts/contact-1/tasks',
      expect.objectContaining({ title: 'Call lead', completed: false }),
    );
    expect((await automation.list(fixture.orgAId))[0]).toMatchObject({ status: 'succeeded' });
  });

  it('atomically claims an approved action so concurrent workers cannot duplicate it', async () => {
    postJson.mockClear();
    const action = await automation.create(fixture.orgAId, fixture.userAId, {
      integrationId,
      kind: 'ghl_task_create',
      title: 'Concurrent follow up',
      payload: { contactId: 'contact-2', title: 'Call lead once' },
    });
    await automation.approve(fixture.orgAId, action.id, fixture.userAId);
    const results = await Promise.allSettled([
      automation.executeApproved(fixture.orgAId, action.id),
      automation.executeApproved(fixture.orgAId, action.id),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(postJson).toHaveBeenCalledTimes(1);
  });

  it('does not automatically replay an uncertain provider failure', async () => {
    postJson.mockClear();
    postJson.mockRejectedValueOnce(new Error('connection reset after request'));
    const action = await automation.create(fixture.orgAId, fixture.userAId, {
      integrationId,
      kind: 'ghl_workflow_trigger',
      title: 'Enroll once',
      payload: { contactId: 'contact-3', workflowId: 'workflow-1' },
    });
    await automation.approve(fixture.orgAId, action.id, fixture.userAId);
    await expect(automation.executeApproved(fixture.orgAId, action.id)).rejects.toThrow(
      'connection reset',
    );
    await expect(automation.executeApproved(fixture.orgAId, action.id)).rejects.toThrow(
      'already executing',
    );
    expect(postJson).toHaveBeenCalledTimes(1);
  });

  it('marks a definitive provider validation rejection as failed', async () => {
    postJson.mockClear();
    postJson.mockRejectedValueOnce(new GhlAdapterError('invalid task payload', 'invalid', 422));
    const action = await automation.create(fixture.orgAId, fixture.userAId, {
      integrationId,
      kind: 'ghl_task_create',
      title: 'Invalid follow up',
      payload: { contactId: 'contact-4', title: 'Invalid task' },
    });
    await automation.approve(fixture.orgAId, action.id, fixture.userAId);
    await expect(automation.executeApproved(fixture.orgAId, action.id)).rejects.toThrow(
      'invalid task payload',
    );
    expect((await automation.list(fixture.orgAId))[0]).toMatchObject({ status: 'failed' });
  });

  it('persists daily briefs and exposes retryable dead-letter jobs', async () => {
    const artifact = await new DashboardService(database()).generateDailyBrief(
      fixture.orgAId,
      new Date('2026-08-04T00:00:00Z'),
    );
    expect(artifact.kind).toBe('daily_brief');
    const run = await serviceDb()
      .insertInto('capere.job_runs')
      .values({
        organization_id: fixture.orgAId,
        job_type: 'automation-execute',
        status: 'dead_lettered',
        attempts: 3,
        max_attempts: 3,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const monitor = new JobMonitoringService(database());
    expect(await monitor.list(fixture.orgAId, 'dead_lettered')).toHaveLength(1);
    expect(await monitor.retry(fixture.orgAId, run.id)).toMatchObject({
      status: 'failed',
      attempts: 0,
      error: null,
    });
  });

  it('deduplicates identical content requests before paying for another model call', async () => {
    const complete = vi.fn().mockResolvedValue({ content: 'Draft content', servedModel: 'test' });
    const service = new ContentGenerationService(database(), new DashboardService(database()), {
      complete,
    } as unknown as ModelRouterService);
    const request = `Unique content request ${crypto.randomUUID()}`;
    const first = await service.generate(fixture.orgAId, request);
    const second = await service.generate(fixture.orgAId, request);
    expect(second.id).toBe(first.id);
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
