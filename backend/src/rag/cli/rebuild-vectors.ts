import 'reflect-metadata';
import * as path from 'node:path';
import * as dotenv from 'dotenv';
import { sql } from 'kysely';
import { loadConfig } from '../../shared/config';
import { DatabaseService } from '../../shared/database';

dotenv.config({ path: path.resolve(__dirname, '../../../../.env'), override: false });

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const database = new DatabaseService(config);
  const generation = process.argv[2]?.trim() || new Date().toISOString();
  try {
    const queuedCount = await database.transaction(async (trx) => {
      const result = await sql<{ document_id: string; version_id: string }>`
        INSERT INTO capere.rag_ingestion_jobs (
          organization_id, document_id, version_id, operation, status, idempotency_key
        )
        SELECT
          d.organization_id,
          d.id,
          d.active_version_id,
          'reindex',
          'queued',
          ${`vector-rebuild:${config.vectorStore.provider}:${generation}:`} || d.active_version_id::text
        FROM capere.rag_documents d
        WHERE d.active_version_id IS NOT NULL
          AND d.status <> 'deleted'
        ON CONFLICT (operation, idempotency_key) DO UPDATE SET
          status = 'queued',
          attempts = 0,
          next_retry_at = NULL,
          lease_until = NULL,
          claimed_by = NULL,
          error_message = NULL,
          updated_at = now()
        RETURNING document_id, version_id
      `.execute(trx);

      if (result.rows.length === 0) return 0;
      const documentIds = result.rows.map((row) => row.document_id);
      const versionIds = result.rows.map((row) => row.version_id);
      await trx
        .updateTable('capere.rag_document_versions')
        .set({ status: 'pending', error_message: null })
        .where('id', 'in', versionIds)
        .execute();
      await trx
        .updateTable('capere.rag_documents')
        .set({ status: 'pending', error_message: null })
        .where('id', 'in', documentIds)
        .execute();
      return result.rows.length;
    });
    process.stdout.write(
      `Queued ${queuedCount} document(s) for ${config.vectorStore.provider} vector rebuild.\n`,
    );
  } finally {
    await database.onModuleDestroy();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
