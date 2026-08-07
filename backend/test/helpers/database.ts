import { randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import { Pool } from 'pg';
import type { Database } from '../../src/shared/database/database.types';
import { resolveSsl } from '../../src/shared/database/ssl';

/**
 * Test database helpers.
 *
 * `serviceDb()` bypasses RLS and is used to ARRANGE fixtures and to VERIFY that
 * a blocked write really did not happen. `asUser()` mirrors
 * DatabaseService.withUserContext exactly — same `SET LOCAL ROLE`, same
 * `set_config` — so the RLS suite exercises the real mechanism rather than an
 * approximation of it.
 *
 * NOTE: this relies on the connecting role bypassing RLS (superuser locally,
 * BYPASSRLS on Supabase). Because every tenant table is FORCE ROW LEVEL
 * SECURITY, a plain owner role would itself be subject to policies.
 */

const configuredTestDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!configuredTestDatabaseUrl) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Configure a dedicated Supabase test project; ' +
      'tests will not fall back to the application database.',
  );
}

const TEST_DATABASE_URL: string = configuredTestDatabaseUrl;

let pool: Pool | undefined;
let db: Kysely<Database> | undefined;

export function serviceDb(): Kysely<Database> {
  if (!db) {
    pool = new Pool({
      connectionString: TEST_DATABASE_URL,
      max: 5,
      ssl: resolveSsl(TEST_DATABASE_URL),
    });
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  }
  return db;
}

export async function closeDb(): Promise<void> {
  await db?.destroy();
  db = undefined;
  pool = undefined;
}

/** Runs `fn` impersonating a Supabase user, exactly as the application does. */
export async function asUser<T>(
  userId: string,
  fn: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  return serviceDb()
    .transaction()
    .execute(async (trx) => {
      const claims = JSON.stringify({ sub: userId, role: 'authenticated' });
      await sql`SET LOCAL ROLE authenticated`.execute(trx);
      await sql`SELECT set_config('request.jwt.claims', ${claims}, true)`.execute(trx);
      return fn(trx);
    });
}

/** Runs `fn` with no JWT claims set — auth.uid() is NULL. */
export async function asAnonymous<T>(fn: (trx: Transaction<Database>) => Promise<T>): Promise<T> {
  return serviceDb()
    .transaction()
    .execute(async (trx) => {
      await sql`SET LOCAL ROLE authenticated`.execute(trx);
      return fn(trx);
    });
}

export interface Fixture {
  orgAId: string;
  orgBId: string;
  userAId: string;
  userBId: string;
  emailA: string;
  emailB: string;
}

/**
 * Creates two fully isolated organizations, each with one owner.
 *
 * The RLS suite then seeds a row in every tenant table for BOTH organizations
 * and proves user A can never reach org B's.
 */
export async function seedTwoOrganizations(): Promise<Fixture> {
  const database = serviceDb();

  const userAId = randomUUID();
  const userBId = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  const emailA = `a-${suffix}@example.com`;
  const emailB = `b-${suffix}@example.com`;

  // auth.users first: capere.users has a foreign key onto it.
  await sql`
    INSERT INTO auth.users (id, email)
    VALUES (${userAId}::uuid, ${emailA}), (${userBId}::uuid, ${emailB})
  `.execute(database);

  const orgs = await database
    .insertInto('capere.organizations')
    .values([
      { name: `Org A ${suffix}`, slug: `org-a-${suffix}` },
      { name: `Org B ${suffix}`, slug: `org-b-${suffix}` },
    ])
    .returning('id')
    .execute();

  await database
    .insertInto('capere.users')
    .values([
      { id: userAId, email: emailA, full_name: 'User A' },
      { id: userBId, email: emailB, full_name: 'User B' },
    ])
    .execute();

  await database
    .insertInto('capere.organization_members')
    .values([
      { organization_id: orgs[0].id, user_id: userAId, role: 'owner' },
      { organization_id: orgs[1].id, user_id: userBId, role: 'owner' },
    ])
    .execute();

  return {
    orgAId: orgs[0].id,
    orgBId: orgs[1].id,
    userAId,
    userBId,
    emailA,
    emailB,
  };
}

/** Removes both organizations and their auth users; cascades clean the rest. */
export async function cleanup(fixture: Fixture): Promise<void> {
  const database = serviceDb();
  await database
    .deleteFrom('capere.organizations')
    .where('id', 'in', [fixture.orgAId, fixture.orgBId])
    .execute();
  await sql`
    DELETE FROM auth.users
    WHERE id IN (${fixture.userAId}::uuid, ${fixture.userBId}::uuid)
  `.execute(database);
}
