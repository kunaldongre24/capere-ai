import * as path from 'node:path';
import * as dotenv from 'dotenv';
import { defineConfig } from 'vitest/config';

// Load .env so TEST_DATABASE_URL reaches the test worker processes, not just
// globalSetup — vitest does not forward the parent environment to workers by
// default, so it has to be injected via `test.env` below.
//
// CONSEQUENCE WORTH KNOWING: because this reads .env directly, `env -u
// TEST_DATABASE_URL pnpm test` does NOT unset the variable — dotenv reloads it
// from the file. The explicit guards in test/setup.ts and test/helpers/database.ts
// therefore only fire where no .env exists, which in practice means CI. That is
// the case they are meant to protect (a CI run must never silently reach for the
// application database), but it does mean they cannot be exercised locally by
// clearing the environment.
dotenv.config({ path: path.resolve(__dirname, '../.env') });

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.spec.ts', 'src/**/*.spec.ts'],
    // Runs once per run: applies migrations. Must be globalSetup, not
    // setupFiles — see test/setup.ts.
    globalSetup: ['test/setup.ts'],
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      ...(process.env.TEST_DATABASE_URL
        ? { TEST_DATABASE_URL: process.env.TEST_DATABASE_URL }
        : {}),
    },
    // Remote Supabase adds real network latency per query.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Integration suites share one database, so parallel files would race on
    // fixtures. Unit specs are fast enough that serializing costs little.
    fileParallelism: false,
  },
});
