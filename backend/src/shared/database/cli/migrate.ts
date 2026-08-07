#!/usr/bin/env tsx
/**
 * Migration CLI.
 *
 *   pnpm migrate           # apply pending migrations
 *   pnpm migrate:down      # unmark the most recent migration
 *   tsx migrate.ts status  # show applied/pending
 *   tsx migrate.ts reset    # drop the capere schema, then re-apply (tests)
 */
import * as dotenv from 'dotenv';
import * as path from 'node:path';
import { MigrationRunner } from '../migrations/runner';

dotenv.config({ path: path.resolve(__dirname, '../../../../../.env') });

const command = process.argv[2] ?? 'up';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env or export it.');
  process.exit(1);
}

async function main(): Promise<void> {
  const runner = new MigrationRunner(databaseUrl as string);

  switch (command) {
    case 'up': {
      const { applied } = await runner.up();
      if (applied.length === 0) {
        console.warn('No pending migrations — database is up to date.');
      } else {
        for (const name of applied) console.warn(`applied  ${name}`);
        console.warn(`\n${applied.length} migration(s) applied.`);
      }
      break;
    }

    case 'down': {
      const { reverted } = await runner.down();
      console.warn(
        reverted
          ? `Unmarked ${reverted}. Note: this does not undo DDL — write a compensating migration.`
          : 'Nothing to revert.',
      );
      break;
    }

    case 'reset': {
      // Destructive by design, and only ever used against a test database.
      await runner.reset();
      const { applied } = await runner.up();
      console.warn(`Reset complete — ${applied.length} migration(s) applied.`);
      break;
    }

    case 'status': {
      const { applied, pending } = await runner.status();
      console.warn(`Applied (${applied.length}):`);
      for (const name of applied) console.warn(`  ${name}`);
      console.warn(`\nPending (${pending.length}):`);
      for (const name of pending) console.warn(`  ${name}`);
      break;
    }

    default:
      console.error(`Unknown command "${command}". Use: up | down | reset | status`);
      process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
