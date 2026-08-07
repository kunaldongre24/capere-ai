import * as path from 'node:path';
import * as dotenv from 'dotenv';
import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

/**
 * E2E suite — boots the full NestJS app and exercises real HTTP endpoints.
 * Runs sequentially to avoid port and database races.
 */
dotenv.config({ path: path.resolve(__dirname, '../.env') });

export default defineConfig({
  plugins: [swc.vite({ tsconfigFile: './tsconfig.json' })],
  test: {
    globals: true,
    environment: 'node',
    include: ['test/e2e/**/*.e2e-spec.ts'],
    globalSetup: ['test/setup.ts'],
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      ...(process.env.TEST_DATABASE_URL
        ? { TEST_DATABASE_URL: process.env.TEST_DATABASE_URL }
        : {}),
    },
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
