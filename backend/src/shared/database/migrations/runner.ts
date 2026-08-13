import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { Client } from 'pg';
import { resolveSsl } from '../ssl';

/**
 * Minimal, dependency-free migration runner.
 *
 * Runs the SQL files in `supabase/migrations/` in filename order, recording each
 * applied migration in `capere._migrations`. Files are applied exactly once;
 * re-running `up` applies only the pending ones. Idempotent, transaction-wrapped
 * per file, so a partially-failed migration never leaves the DB half-migrated.
 * The migration target is the configured Supabase PostgreSQL project.
 */

const DEFAULT_DIR = path.resolve(__dirname, '../../../../supabase/migrations');

interface MigrationRow {
  name: string;
  applied_at: string;
}

export class MigrationRunner {
  constructor(
    private readonly connectionString: string,
    private readonly migrationsDir: string = DEFAULT_DIR,
    private readonly disableSsl: boolean = false,
  ) {}

  private async withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({
      connectionString: this.connectionString,
      ssl: this.disableSsl ? false : resolveSsl(this.connectionString),
    });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  private async ensureMigrationsTable(client: Client): Promise<void> {
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS capere;
      CREATE TABLE IF NOT EXISTS capere._migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  }

  private listMigrationFiles(): string[] {
    const files = readdirSync(this.migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    if (files.length === 0) {
      throw new Error(`No .sql migrations found in ${this.migrationsDir}`);
    }
    return files;
  }

  private async appliedNames(client: Client): Promise<Set<string>> {
    const { rows } = await client.query<MigrationRow>('SELECT name FROM capere._migrations');
    return new Set(rows.map((r) => r.name));
  }

  async up(): Promise<{ applied: string[]; pending: string[] }> {
    return this.withClient(async (client) => {
      await this.ensureMigrationsTable(client);
      const files = this.listMigrationFiles();
      const applied = await this.appliedNames(client);
      const pending = files.filter((f) => !applied.has(f));
      const nowApplied: string[] = [];

      for (const file of pending) {
        const sql = readFileSync(path.join(this.migrationsDir, file), 'utf8');
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO capere._migrations (name) VALUES ($1)', [file]);
          await client.query('COMMIT');
          nowApplied.push(file);
        } catch (error) {
          await client.query('ROLLBACK');
          throw new Error(
            `Migration ${file} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      return { applied: nowApplied, pending };
    });
  }

  async down(): Promise<{ reverted: string | null }> {
    return this.withClient(async (client) => {
      await this.ensureMigrationsTable(client);
      const { rows } = await client.query<MigrationRow>(
        'SELECT name FROM capere._migrations ORDER BY applied_at DESC LIMIT 1',
      );
      if (rows.length === 0) return { reverted: null };
      const last = rows[0].name;
      await client.query('DELETE FROM capere._migrations WHERE name = $1', [last]);
      return { reverted: last };
    });
  }

  /** Drops the entire capere schema — used by test setup for a clean slate. */
  async reset(): Promise<void> {
    await this.withClient(async (client) => {
      await client.query('DROP SCHEMA IF EXISTS capere CASCADE');
    });
  }

  async status(): Promise<{ applied: string[]; pending: string[] }> {
    return this.withClient(async (client) => {
      await this.ensureMigrationsTable(client);
      const files = this.listMigrationFiles();
      const applied = await this.appliedNames(client);
      return {
        applied: files.filter((f) => applied.has(f)),
        pending: files.filter((f) => !applied.has(f)),
      };
    });
  }
}
