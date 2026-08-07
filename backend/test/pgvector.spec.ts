import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PgVectorStore } from '../src/rag/pgvector-vector.store';
import { loadConfig } from '../src/shared/config';
import type { DatabaseService } from '../src/shared/database';
import {
  cleanup,
  closeDb,
  asAnonymous,
  asUser,
  seedTwoOrganizations,
  serviceDb,
  type Fixture,
} from './helpers/database';

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://postgres:password@localhost:5432/postgres',
  REDIS_URL: 'redis://localhost:6379',
  API_KEYS_HASHING_SALT: 'test-salt-0123456789abcdef',
  KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  VECTOR_STORE_PROVIDER: 'pgvector',
  RAG_EMBEDDING_DIMENSIONS: '1536',
  RAG_VECTOR_WRITE_BATCH_SIZE: '2',
});

function database(): DatabaseService {
  return {
    db: serviceDb(),
    transaction: (fn) => serviceDb().transaction().execute(fn),
  } as DatabaseService;
}

describe('Supabase pgvector store', () => {
  let fixture: Fixture;
  let store: PgVectorStore;
  const documentIds: string[] = [];

  beforeAll(async () => {
    fixture = await seedTwoOrganizations();
    store = new PgVectorStore(database(), config);
  });

  afterAll(async () => {
    if (documentIds.length > 0) {
      await serviceDb().deleteFrom('capere.rag_documents').where('id', 'in', documentIds).execute();
    }
    await cleanup(fixture);
    await closeDb();
  });

  it('stores vectors and returns shared plus same-tenant knowledge only', async () => {
    const run = crypto.randomUUID().slice(0, 8);
    const sharedTitle = `Shared playbook ${run}`;
    const orgATitle = `Org A SOP ${run}`;
    const orgBTitle = `Org B SOP ${run}`;
    const shared = await source(null, 'shared', sharedTitle);
    const orgA = await source(fixture.orgAId, 'tenant', orgATitle);
    const orgB = await source(fixture.orgBId, 'tenant', orgBTitle);
    const vector = Array<number>(1536).fill(0);
    vector[0] = 1;

    const assertLease = vi.fn().mockResolvedValue(undefined);
    await store.upsert(
      [shared, orgA, orgB].map((item) => ({
        pointId: item.chunkId,
        vector,
        payload: {
          documentId: item.documentId,
          versionId: item.versionId,
          chunkId: item.chunkId,
          visibility: item.visibility,
          organizationId: item.organizationId,
          title: item.title,
          source: `${item.title}.md`,
          content: `${item.title} content`,
          checksum: 'c'.repeat(64),
        },
      })),
      assertLease,
    );
    expect(assertLease).toHaveBeenCalledTimes(2);

    const orgAHits = await store.search({ organizationId: fixture.orgAId, vector, limit: 10 });
    const orgBHits = await store.search({ organizationId: fixture.orgBId, vector, limit: 10 });

    const orgATitles = orgAHits.map((hit) => hit.citation.title);
    const orgBTitles = orgBHits.map((hit) => hit.citation.title);
    expect(orgATitles).toEqual(expect.arrayContaining([orgATitle, sharedTitle]));
    expect(orgATitles).not.toContain(orgBTitle);
    expect(orgBTitles).toEqual(expect.arrayContaining([orgBTitle, sharedTitle]));
    expect(orgBTitles).not.toContain(orgATitle);

    const rlsTitles = await asUser(fixture.userAId, async (trx) => {
      const result = await sql<{ title: string }>`
        SELECT d.title
        FROM capere.rag_vector_points p
        JOIN capere.rag_documents d ON d.id = p.document_id
        WHERE d.title IN (${sharedTitle}, ${orgATitle}, ${orgBTitle})
      `.execute(trx);
      return result.rows.map((row) => row.title).sort();
    });
    expect(rlsTitles).toEqual([orgATitle, sharedTitle].sort());

    const anonymousShared = await asAnonymous(async (trx) => {
      const result = await sql<{ count: string }>`
        SELECT count(*)::text AS count
        FROM capere.rag_vector_points
        WHERE document_id = ${shared.documentId}::uuid
      `.execute(trx);
      return Number(result.rows[0].count);
    });
    expect(anonymousShared).toBe(0);

    await asUser(fixture.userAId, (trx) =>
      sql`DELETE FROM capere.rag_vector_points WHERE point_id = ${orgA.chunkId}::uuid`.execute(trx),
    );
    expect(
      await serviceDb()
        .selectFrom('capere.rag_vector_points')
        .select('point_id')
        .where('point_id', '=', orgA.chunkId)
        .executeTakeFirst(),
    ).toBeTruthy();
  });

  async function source(
    organizationId: string | null,
    visibility: 'shared' | 'tenant',
    title: string,
  ) {
    const suffix = crypto.randomUUID();
    const document = await serviceDb()
      .insertInto('capere.rag_documents')
      .values({
        organization_id: organizationId,
        visibility,
        title,
        source_filename: `${suffix}.md`,
        source_mime_type: 'text/markdown',
        source_bytes: '100',
        storage_path: `rag/pgvector-test/${suffix}.md`,
        source_checksum: suffix.replaceAll('-', '').padEnd(64, '0'),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    documentIds.push(document.id);
    const version = await serviceDb()
      .insertInto('capere.rag_document_versions')
      .values({
        document_id: document.id,
        version_number: 1,
        source_checksum: suffix.replaceAll('-', '').padEnd(64, '1'),
        parser_fingerprint: 'test',
        chunker_fingerprint: 'test',
        embedding_fingerprint: 'test:1536',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const chunk = await serviceDb()
      .insertInto('capere.rag_chunks')
      .values({
        version_id: version.id,
        sequence: 0,
        content: `${title} content`,
        content_checksum: suffix.replaceAll('-', '').padEnd(64, '2'),
        character_count: 20,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return {
      documentId: document.id,
      versionId: version.id,
      chunkId: chunk.id,
      organizationId,
      visibility,
      title,
    };
  }
});
