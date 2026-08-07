import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { GhlAdapter, GhlAdapterError } from '../integrations/ghl/ghl.adapter';
import { GhlTokenService } from '../integrations/ghl/ghl-token.service';
import { DatabaseService, type AutomationKind } from '../shared/database';
import type { CreateAutomationDto } from './automation.dto';

const taskSchema = z.object({
  contactId: z.string().min(1),
  title: z.string().min(1).max(200),
  body: z.string().max(5000).optional(),
  dueDate: z.string().optional(),
  completed: z.boolean().default(false),
});
const workflowSchema = z.object({ contactId: z.string().min(1), workflowId: z.string().min(1) });

@Injectable()
export class AutomationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly tokens: GhlTokenService,
    private readonly ghl: GhlAdapter,
  ) {}

  async create(organizationId: string, userId: string, dto: CreateAutomationDto) {
    this.validate(dto.kind, dto.payload);
    return this.database.db
      .insertInto('capere.automation_actions')
      .values({
        organization_id: organizationId,
        integration_id: dto.integrationId,
        recommendation_id: dto.recommendationId ?? null,
        kind: dto.kind,
        title: dto.title,
        payload: JSON.stringify(dto.payload),
        created_by: userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  list(organizationId: string) {
    return this.database.db
      .selectFrom('capere.automation_actions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .orderBy('created_at', 'desc')
      .limit(100)
      .execute();
  }

  async approve(organizationId: string, id: string, userId: string) {
    return this.database.transaction(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`automation:${id}`},0))`.execute(
        trx,
      );
      const action = await trx
        .selectFrom('capere.automation_actions')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('status', '=', 'draft')
        .forUpdate()
        .executeTakeFirstOrThrow();
      await trx
        .updateTable('capere.automation_actions')
        .set({ status: 'approved', approved_by: userId, approved_at: new Date() })
        .where('id', '=', id)
        .execute();
      await trx
        .insertInto('capere.scheduled_jobs')
        .values({
          organization_id: organizationId,
          job_type: 'automation-execute',
          name: `automation-execute:${id}`,
          schedule: 'hourly',
          enabled: true,
          next_run_at: new Date(),
          payload: JSON.stringify({ actionId: id }),
        })
        .onConflict((oc) =>
          oc
            .columns(['organization_id', 'name'])
            .doUpdateSet({ enabled: true, next_run_at: new Date() }),
        )
        .execute();
      return { id: action.id, status: 'approved' as const };
    });
  }

  async executeApproved(organizationId: string, id: string) {
    // Atomically claim the command. `executing` is deliberately not accepted:
    // after a worker dies or a provider response is lost we cannot know whether
    // GHL applied the mutation, so automatically replaying it could duplicate a
    // task or workflow enrollment. Such rows require operator reconciliation.
    const action = await this.database.db
      .updateTable('capere.automation_actions')
      .set({ status: 'executing', error: null })
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .where('status', '=', 'approved')
      .returningAll()
      .executeTakeFirst();
    if (!action) throw new Error('Automation action is not approved or is already executing');
    const integration = await this.database.db
      .selectFrom('capere.integrations')
      .select(['id', 'account_id', 'provider'])
      .where('organization_id', '=', organizationId)
      .where('id', '=', action.integration_id)
      .executeTakeFirstOrThrow();
    if (integration.provider !== 'go_high_level' || !integration.account_id)
      throw new Error('Automation requires a connected GoHighLevel location');
    const credentials = await this.tokens.credentials(organizationId, integration.id);
    const payload = this.validate(action.kind, action.payload);
    try {
      const contactId = String(payload.contactId);
      const result =
        action.kind === 'ghl_task_create'
          ? await this.ghl.postJson(
              credentials,
              `contacts/${encodeURIComponent(contactId)}/tasks`,
              {
                title: payload.title,
                body: payload.body,
                dueDate: payload.dueDate,
                completed: payload.completed,
              },
            )
          : await this.ghl.postJson(
              credentials,
              `contacts/${encodeURIComponent(contactId)}/workflow/${encodeURIComponent(String(payload.workflowId))}`,
              {},
            );
      await this.database.db
        .updateTable('capere.automation_actions')
        .set({ status: 'succeeded', result: JSON.stringify(result), executed_at: new Date() })
        .where('id', '=', id)
        .execute();
      return result;
    } catch (error) {
      // A provider response proves the request completed at the HTTP layer. For
      // failures where no success response was received, keep `executing`
      // instead of inviting an unsafe automatic replay. An operator can inspect
      // GHL and explicitly approve a replacement command if needed.
      const definitiveFailure = error instanceof GhlAdapterError && error.kind === 'invalid';
      await this.database.db
        .updateTable('capere.automation_actions')
        .set({
          status: definitiveFailure ? 'failed' : 'executing',
          error: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
          executed_at: new Date(),
        })
        .where('id', '=', id)
        .where('status', '=', 'executing')
        .execute();
      throw error;
    }
  }

  private validate(kind: AutomationKind, value: unknown): Record<string, unknown> {
    const object = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
    return (kind === 'ghl_task_create' ? taskSchema : workflowSchema).parse(object);
  }
}
