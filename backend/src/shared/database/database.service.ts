import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import { Pool } from 'pg';
import { APP_CONFIG, type AppConfig } from '../config';
import type { Database } from './database.types';
import { resolveSsl } from './ssl';

/**
 * The two-client model.
 *
 * WHY THIS EXISTS — the single most important security detail in the codebase:
 *
 * Supabase's RLS policies are written against `auth.uid()`, which reads the
 * `request.jwt.claims` setting. When you connect through Supabase's REST API,
 * that setting is populated for you. When you connect DIRECTLY to Postgres (as
 * this service does, for type-safe Kysely queries), nothing populates it — so
 * `auth.uid()` returns NULL, every policy evaluates false, and depending on the
 * connecting role you either see nothing or, far worse, bypass RLS entirely and
 * see EVERY tenant's data.
 *
 * So we expose two deliberately distinct clients:
 *
 *   1. `db` — the service client. Connects as the owning/service role and
 *      bypasses RLS. For workers, migrations, the outbox relay, and system jobs
 *      that legitimately act across tenants. Callers MUST scope by
 *      organization_id themselves; nothing else will.
 *
 *   2. `withUserContext(userId, fn)` — opens a transaction, sets
 *      `SET LOCAL ROLE authenticated` and `set_config('request.jwt.claims', …,
 *      true)`, then runs `fn`. Both are transaction-local (`LOCAL` / third arg
 *      `true`), so they are reverted on COMMIT/ROLLBACK and cannot leak to the
 *      next borrower of a pooled connection. This is what makes RLS actually
 *      apply — and what makes it safe behind pgbouncer in transaction mode.
 *
 * Rule of thumb: request-scoped reads go through `withUserContext`. Anything
 * else uses `db` and scopes by organization_id explicitly.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly pool: Pool;

  /**
   * Service-role client. Bypasses RLS — always scope queries by
   * organization_id when using this directly.
   */
  public readonly db: Kysely<Database>;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.pool = new Pool({
      connectionString: config.database.url,
      max: config.database.poolMax,
      ssl: config.database.sslMode === 'disable' ? false : resolveSsl(config.database.url, config.database.sslCa),
      // Fail fast rather than queueing forever behind an exhausted pool.
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      allowExitOnIdle: config.isTest,
    });

    this.pool.on('error', (error) => {
      // An idle client erroring out must not take the process down.
      this.logger.error(`Idle Postgres client error: ${error.message}`);
    });

    this.db = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: this.pool }),
      log: ['error'],
    });
  }

  /**
   * Runs `fn` inside a transaction that impersonates the given Supabase user, so
   * RLS policies evaluate exactly as they would through Supabase's own API.
   *
   * @param userId  The Supabase auth user id (the JWT `sub` claim).
   * @param fn      Receives an RLS-constrained transaction handle.
   * @param claims  Extra JWT claims to expose to policies (role, email, …).
   */
  async withUserContext<T>(
    userId: string,
    fn: (trx: Transaction<Database>) => Promise<T>,
    claims: Record<string, unknown> = {},
  ): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      // The claims blob policies read via auth.uid() / auth.jwt().
      const jwtClaims = JSON.stringify({
        sub: userId,
        role: 'authenticated',
        ...claims,
      });

      // SET LOCAL ROLE drops superuser/owner privileges for this transaction, so
      // FORCE ROW LEVEL SECURITY genuinely binds. Without it the owner role
      // would still bypass policies.
      await sql`SET LOCAL ROLE authenticated`.execute(trx);

      // Third arg `true` = transaction-local, reverted on commit/rollback.
      // Parameterized: never interpolate claims into SQL text.
      await sql`SELECT set_config('request.jwt.claims', ${jwtClaims}, true)`.execute(trx);

      return fn(trx);
    });
  }

  /**
   * Runs `fn` as the service role inside a transaction — for multi-statement
   * system work that must be atomic (e.g. a state change plus its outbox event).
   */
  async transaction<T>(fn: (trx: Transaction<Database>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(fn);
  }

  /** Liveness probe for the health endpoint. */
  async ping(): Promise<boolean> {
    try {
      await sql`SELECT 1`.execute(this.db);
      return true;
    } catch (error) {
      this.logger.error(
        `Database ping failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.db.destroy();
  }
}
