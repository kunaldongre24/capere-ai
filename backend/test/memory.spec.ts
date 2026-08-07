import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryService, NullSemanticMemory } from '../src/hermes/memory/memory.service';
import type { DatabaseService, Database } from '../src/shared/database';
import {
  cleanup,
  closeDb,
  seedTwoOrganizations,
  serviceDb,
  type Fixture,
} from './helpers/database';
import type { Transaction } from 'kysely';
import { sql } from 'kysely';

describe('MemoryService session isolation', () => {
  let fixture: Fixture;
  let memory: MemoryService;
  let userA2Id: string;

  beforeAll(async () => {
    fixture = await seedTwoOrganizations();
    userA2Id = randomUUID();
    await sql`
      INSERT INTO auth.users (id, email)
      VALUES (${userA2Id}::uuid, ${`a2-${userA2Id}@example.com`})
    `.execute(serviceDb());
    await serviceDb()
      .insertInto('capere.users')
      .values({ id: userA2Id, email: `a2-${userA2Id}@example.com`, full_name: 'User A2' })
      .execute();
    await serviceDb()
      .insertInto('capere.organization_members')
      .values({ organization_id: fixture.orgAId, user_id: userA2Id, role: 'owner' })
      .execute();

    const database = {
      db: serviceDb(),
      transaction: <T>(fn: (trx: Transaction<Database>) => Promise<T>) =>
        serviceDb().transaction().execute(fn),
    } as unknown as DatabaseService;
    memory = new MemoryService(database, new NullSemanticMemory());
  });

  beforeEach(async () => {
    await serviceDb()
      .deleteFrom('capere.ai_sessions')
      .where('organization_id', 'in', [fixture.orgAId, fixture.orgBId])
      .execute();
  });

  afterAll(async () => {
    await sql`DELETE FROM auth.users WHERE id = ${userA2Id}::uuid`.execute(serviceDb());
    await cleanup(fixture);
    await closeDb();
  });

  it('allows only the owning human to access a session', async () => {
    const sessionId = await memory.createSession({
      organizationId: fixture.orgAId,
      userId: fixture.userAId,
      agent: 'hermes',
    });

    await expect(
      memory.assertSessionAccess({
        organizationId: fixture.orgAId,
        sessionId,
        userId: fixture.userAId,
      }),
    ).resolves.toBeUndefined();
    await expect(
      memory.assertSessionAccess({ organizationId: fixture.orgAId, sessionId, userId: userA2Id }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('never authorizes a session ID from another organization', async () => {
    const sessionId = await memory.createSession({
      organizationId: fixture.orgBId,
      userId: fixture.userBId,
      agent: 'hermes',
    });

    await expect(
      memory.assertSessionAccess({
        organizationId: fixture.orgAId,
        sessionId,
        userId: fixture.userAId,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(memory.recent(fixture.orgAId, sessionId)).resolves.toEqual([]);
  });

  it('allows machine access only within the machine key organization', async () => {
    const sessionId = await memory.createSession({
      organizationId: fixture.orgAId,
      userId: fixture.userAId,
      agent: 'hermes',
    });

    await expect(
      memory.assertSessionAccess({
        organizationId: fixture.orgAId,
        sessionId,
        machineAccess: true,
      }),
    ).resolves.toBeUndefined();
    await expect(
      memory.assertSessionAccess({
        organizationId: fixture.orgBId,
        sessionId,
        machineAccess: true,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('rejects inactive sessions', async () => {
    const sessionId = await memory.createSession({
      organizationId: fixture.orgAId,
      userId: fixture.userAId,
      agent: 'hermes',
    });
    await serviceDb()
      .updateTable('capere.ai_sessions')
      .set({ status: 'completed' })
      .where('id', '=', sessionId)
      .execute();

    await expect(
      memory.assertSessionAccess({
        organizationId: fixture.orgAId,
        sessionId,
        userId: fixture.userAId,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('serializes concurrent first appends without duplicate sequences', async () => {
    const sessionId = await memory.createSession({
      organizationId: fixture.orgAId,
      userId: fixture.userAId,
      agent: 'hermes',
    });

    const turns = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        memory.append({
          organizationId: fixture.orgAId,
          sessionId,
          role: 'user',
          content: `message-${index}`,
        }),
      ),
    );

    expect(turns.map((turn) => turn.sequence).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    await expect(memory.recent(fixture.orgAId, sessionId)).resolves.toHaveLength(6);
  });
});
