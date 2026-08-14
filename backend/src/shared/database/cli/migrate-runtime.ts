import { MigrationRunner } from '../migrations/runner';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) throw new Error('DATABASE_URL is required for migrations');

new MigrationRunner(
  databaseUrl,
  undefined,
  process.env.DATABASE_SSL_MODE === 'disable',
)
  .up()
  .then(({ applied }) => {
    for (const name of applied) console.warn(`applied ${name}`);
    console.warn(
      applied.length
        ? `${applied.length} migration(s) applied.`
        : 'No pending migrations - database is up to date.',
    );
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
