import { execSync } from 'node:child_process';
import * as path from 'node:path';
import * as dotenv from 'dotenv';

/**
 * Vitest GLOBAL setup — runs once per run, before any suite.
 *
 * Must be wired as `globalSetup`, not `setupFiles`: `setupFiles` runs per test
 * file and never invokes an exported `setup()`, so migrations would silently
 * not run and the RLS suite would fail against an empty schema.
 *
 * SAFETY — this matters, because TEST_DATABASE_URL points at a hosted Supabase
 * project. Only `migrate up` is run here: forward-only and never destructive.
 * Fixtures use generated UUIDs and clean up after themselves.
 */

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export async function setup(): Promise<void> {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;

  if (!testDatabaseUrl) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Configure a dedicated Supabase test project; ' +
        'tests will not fall back to the application database.',
    );
  }

  console.warn(
    `\n  Tests are running against Supabase PostgreSQL: ${new URL(testDatabaseUrl).hostname}\n` +
      '  Applying migrations forward-only (no reset). Fixtures self-clean.\n',
  );

  const migrateCli = path.resolve(__dirname, '../src/shared/database/cli/migrate.ts');
  try {
    // Invoke tsx as a Node loader instead of the tsx CLI. The CLI opens a
    // local IPC pipe, which is unavailable in restricted CI/container
    // environments; the loader path has identical TypeScript semantics.
    execSync(`node --import tsx "${migrateCli}" up`, {
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: testDatabaseUrl },
    });
  } catch {
    throw new Error(
      `Could not migrate the Supabase test database.\n` +
        `  host:    ${new URL(testDatabaseUrl).hostname}\n` +
        '  command: migrate up',
    );
  }
}
