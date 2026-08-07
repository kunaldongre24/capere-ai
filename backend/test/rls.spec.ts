import { sql, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../src/shared/database/database.types';
import {
  asAnonymous,
  asUser,
  cleanup,
  closeDb,
  seedTwoOrganizations,
  serviceDb,
  type Fixture,
} from './helpers/database';

/**
 * ============================================================================
 * THE MOST IMPORTANT TEST IN THIS CODEBASE.
 * ============================================================================
 *
 * Capere is multi-tenant: every organization is a CPA firm, and a cross-tenant
 * read is the worst failure this system could have. Row-Level Security is the
 * database-level backstop for the application's own org scoping.
 *
 * This suite seeds TWO organizations, puts a row in EVERY tenant-scoped table
 * for each, and then asserts — as user A — that org B's rows are invisible and
 * immutable. It also proves the mechanism itself works: that `auth.uid()`
 * resolves from transaction-local JWT claims, and that WITHOUT those claims
 * nothing is visible at all.
 *
 * If this suite ever regresses, tenant isolation is broken. It must never be
 * skipped, weakened, or marked as expected-to-fail.
 */

/** One tenant-scoped table and how to create a row in it. */
interface TenantTable {
  readonly table: string;
  readonly idColumn?: string;
  /** Members can SELECT their own org's rows. */
  readonly readable: boolean;
  /** Members can INSERT/UPDATE/DELETE (false for append-only ledgers). */
  readonly writable: boolean;
  /** Inserts one row for `organizationId`, returning its id. */
  seed(organizationId: string, fixture: Fixture): Promise<string>;
  /**
   * Raw SQL that inserts a MINIMAL valid row into this table for the given
   * organization. Used to prove the RLS `WITH CHECK` clause rejects a row
   * stamped with someone else's organization_id.
   *
   * Why not reuse `seed()`: seed uses the service client, which bypasses RLS by
   * design. This has to run inside a user-scoped transaction, so it needs raw
   * SQL parameterized on the org id.
   *
   * An earlier version tried `INSERT INTO t SELECT * FROM t WHERE id = <orgB>`
   * to be table-agnostic. That silently passed for the wrong reason: RLS
   * already hides org B's row, so the SELECT matched nothing, zero rows were
   * inserted, and nothing threw. The lesson — a negative test that cannot
   * distinguish "correctly blocked" from "did nothing" is not a test.
   */
  crossTenantInsert?(trx: Transaction<Database>, foreignOrgId: string): Promise<unknown>;
}

const db = () => serviceDb();

/**
 * Parent-row ids captured at seed time, keyed `<table>:<organizationId>`.
 *
 * Needed because a `crossTenantInsert` must reference a parent row that EXISTS
 * but is INVISIBLE to the acting user. Selecting the parent from inside the
 * user-scoped transaction cannot work — RLS hides it, the SELECT matches
 * nothing, zero rows are inserted, and the test passes without ever exercising
 * the policy. Capturing the id here with the service client (which bypasses
 * RLS) is what makes the negative assertion real.
 */
const parentIds = new Map<string, string>();

const TENANT_TABLES: TenantTable[] = [
  {
    table: 'capere.ghl_locations',
    readable: true,
    writable: true,
    async seed(organizationId) {
      const row = await db()
        .insertInto('capere.ghl_locations')
        .values({
          organization_id: organizationId,
          ghl_location_id: `loc_${organizationId.slice(0, 8)}`,
          name: 'Main office',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    },
    crossTenantInsert(trx, foreignOrgId) {
      return sql`
        INSERT INTO capere.ghl_locations (organization_id, ghl_location_id)
        VALUES (${foreignOrgId}::uuid, 'intruder')
      `.execute(trx);
    },
  },
  {
    table: 'capere.integrations',
    readable: true,
    writable: true,
    async seed(organizationId) {
      const row = await db()
        .insertInto('capere.integrations')
        .values({
          organization_id: organizationId,
          provider: 'go_high_level',
          status: 'connected',
          account_name: 'Acme CPA',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      parentIds.set(`integrations:${organizationId}`, row.id);
      return row.id;
    },
    crossTenantInsert(trx, foreignOrgId) {
      return sql`
        INSERT INTO capere.integrations (organization_id, provider)
        VALUES (${foreignOrgId}::uuid, 'github')
      `.execute(trx);
    },
  },
  {
    table: 'capere.api_keys',
    readable: true,
    writable: true,
    async seed(organizationId) {
      const row = await db()
        .insertInto('capere.api_keys')
        .values({
          organization_id: organizationId,
          name: 'Open WebUI',
          key_prefix: `cap_${organizationId.slice(0, 8)}`,
          key_hash: `hash_${organizationId}`,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    },
    crossTenantInsert(trx, foreignOrgId) {
      return sql`
        INSERT INTO capere.api_keys (organization_id, name, key_prefix, key_hash)
        VALUES (${foreignOrgId}::uuid, 'intruder', 'cap_evil', ${`hash_evil_${foreignOrgId}`})
      `.execute(trx);
    },
  },
  {
    table: 'capere.ai_sessions',
    readable: true,
    writable: true,
    async seed(organizationId) {
      const row = await db()
        .insertInto('capere.ai_sessions')
        .values({ organization_id: organizationId, agent: 'hermes', title: 'Morning brief' })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    },
    crossTenantInsert(trx, foreignOrgId) {
      return sql`
        INSERT INTO capere.ai_sessions (organization_id, agent)
        VALUES (${foreignOrgId}::uuid, 'hermes')
      `.execute(trx);
    },
  },
  {
    table: 'capere.business_memory',
    readable: true,
    writable: true,
    async seed(organizationId) {
      const row = await db()
        .insertInto('capere.business_memory')
        .values({
          organization_id: organizationId,
          key: 'firm.profile',
          value: JSON.stringify({ employees: 12 }),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    },
    crossTenantInsert(trx, foreignOrgId) {
      return sql`
        INSERT INTO capere.business_memory (organization_id, key, value)
        VALUES (${foreignOrgId}::uuid, 'intruder', '{}')
      `.execute(trx);
    },
  },
  {
    table: 'capere.prompt_overrides',
    readable: true,
    writable: true,
    async seed(organizationId) {
      const row = await db()
        .insertInto('capere.prompt_overrides')
        .values({
          organization_id: organizationId,
          name: 'hermes.system',
          content: 'Custom system prompt',
          checksum: 'abc123',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    },
    crossTenantInsert(trx, foreignOrgId) {
      return sql`
        INSERT INTO capere.prompt_overrides (organization_id, name, content, checksum)
        VALUES (${foreignOrgId}::uuid, 'intruder', 'x', 'y')
      `.execute(trx);
    },
  },
  {
    table: 'capere.ai_usage_events',
    readable: true,
    // Append-only ledger: readable by members, written only by the service role.
    writable: false,
    async seed(organizationId) {
      const row = await db()
        .insertInto('capere.ai_usage_events')
        .values({
          organization_id: organizationId,
          requested_model: 'anthropic/claude-3.5-sonnet',
          served_model: 'anthropic/claude-3.5-sonnet',
          total_tokens: 100,
          cost_micro_usd: '1500',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    },
  },
  {
    table: 'capere.ai_budgets',
    readable: true,
    // Only owners/admins may write; both fixture users ARE owners, so writable.
    writable: true,
    async seed(organizationId) {
      const row = await db()
        .insertInto('capere.ai_budgets')
        .values({ organization_id: organizationId, limit_micro_usd: '50000000' })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    },
    crossTenantInsert(trx, foreignOrgId) {
      return sql`
        INSERT INTO capere.ai_budgets (organization_id, period, limit_micro_usd)
        VALUES (${foreignOrgId}::uuid, 'daily', 1)
      `.execute(trx);
    },
  },
  {
    table: 'capere.domain_events',
    readable: true,
    writable: false,
    async seed(organizationId) {
      const row = await db()
        .insertInto('capere.domain_events')
        .values({
          organization_id: organizationId,
          type: 'integration.connected',
          payload: JSON.stringify({ provider: 'go_high_level' }),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    },
  },
  {
    table: 'capere.insights',
    readable: true,
    writable: true,
    async seed(organizationId) {
      const row = await db()
        .insertInto('capere.insights')
        .values({
          organization_id: organizationId,
          category: 'seo',
          source_generator: 'integration_disconnected',
          title: 'GA4 disconnected',
          body: 'Reconnect Google Analytics to resume reporting.',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    },
    crossTenantInsert(trx, foreignOrgId) {
      return sql`
        INSERT INTO capere.insights (organization_id, category, source_generator, title, body)
        VALUES (${foreignOrgId}::uuid, 'seo', 'intruder', 'x', 'y')
      `.execute(trx);
    },
  },
  {
    table: 'capere.scheduled_jobs',
    readable: true,
    writable: true,
    async seed(organizationId) {
      const row = await db()
        .insertInto('capere.scheduled_jobs')
        .values({
          organization_id: organizationId,
          job_type: 'analytics-sync',
          name: 'Nightly GA4 sync',
          schedule: '0 3 * * *',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    },
    crossTenantInsert(trx, foreignOrgId) {
      return sql`
        INSERT INTO capere.scheduled_jobs (organization_id, job_type, name, schedule)
        VALUES (${foreignOrgId}::uuid, 'intruder', 'intruder', '0 0 * * *')
      `.execute(trx);
    },
  },
  {
    table: 'capere.job_runs',
    readable: true,
    writable: true,
    async seed(organizationId) {
      const row = await db()
        .insertInto('capere.job_runs')
        .values({ organization_id: organizationId, job_type: 'analytics-sync' })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    },
    crossTenantInsert(trx, foreignOrgId) {
      return sql`
        INSERT INTO capere.job_runs (organization_id, job_type)
        VALUES (${foreignOrgId}::uuid, 'intruder')
      `.execute(trx);
    },
  },
  {
    table: 'capere.webhook_logs',
    readable: true,
    writable: false,
    async seed(organizationId) {
      const row = await db()
        .insertInto('capere.webhook_logs')
        .values({ organization_id: organizationId, provider: 'go_high_level' })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    },
  },
  {
    table: 'capere.audit_logs',
    readable: true,
    writable: false,
    async seed(organizationId) {
      const row = await db()
        .insertInto('capere.audit_logs')
        .values({ organization_id: organizationId, action: 'integration.connected' })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    },
  },
  {
    // Holds actual AI transcript content — the most sensitive table here.
    // Depends on ai_sessions, so it is seeded via its own session rather than
    // relying on ordering within this array.
    table: 'capere.conversation_messages',
    readable: true,
    writable: true,
    async seed(organizationId) {
      const session = await db()
        .insertInto('capere.ai_sessions')
        .values({ organization_id: organizationId, agent: 'hermes', title: 'RLS message parent' })
        .returning('id')
        .executeTakeFirstOrThrow();

      // Captured with the service client so crossTenantInsert can name a
      // parent that exists but is invisible to the acting user.
      parentIds.set(`conversation_messages:${organizationId}`, session.id);

      const row = await db()
        .insertInto('capere.conversation_messages')
        .values({
          session_id: session.id,
          organization_id: organizationId,
          role: 'user',
          content: `Confidential question for ${organizationId}`,
          sequence: 1,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    },
    crossTenantInsert(trx, foreignOrgId) {
      const foreignSessionId = parentIds.get(`conversation_messages:${foreignOrgId}`);
      if (!foreignSessionId) throw new Error('conversation_messages parent was not captured');

      return sql`
        INSERT INTO capere.conversation_messages
          (session_id, organization_id, role, content, sequence)
        VALUES (${foreignSessionId}::uuid, ${foreignOrgId}::uuid, 'user', 'intruder', 999)
      `.execute(trx);
    },
  },
  {
    table: 'capere.organization_feature_flags',
    readable: true,
    writable: true,
    async seed(organizationId) {
      const flag = await db()
        .insertInto('capere.feature_flags')
        .values({
          key: `rls.test.${organizationId.slice(0, 8)}`,
          description: 'RLS coverage fixture',
          default_enabled: false,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      const row = await db()
        .insertInto('capere.organization_feature_flags')
        .values({ organization_id: organizationId, flag_id: flag.id, enabled: true })
        .returning('id')
        .executeTakeFirstOrThrow();

      parentIds.set(`organization_feature_flags:${organizationId}`, flag.id);
      return row.id;
    },
    crossTenantInsert(trx, foreignOrgId) {
      const flagId = parentIds.get(`organization_feature_flags:${foreignOrgId}`);
      if (!flagId) throw new Error('feature flag parent was not captured');

      return sql`
        INSERT INTO capere.organization_feature_flags (organization_id, flag_id, enabled)
        VALUES (${foreignOrgId}::uuid, ${flagId}::uuid, true)
      `.execute(trx);
    },
  },
  {
    table: 'capere.ai_budget_alerts',
    readable: true,
    // Written by the service role only; members have SELECT via policy.
    writable: false,
    async seed(organizationId) {
      const budget = await db()
        .insertInto('capere.ai_budgets')
        .values({
          organization_id: organizationId,
          period: 'weekly',
          limit_micro_usd: '1000000',
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      const row = await db()
        .insertInto('capere.ai_budget_alerts')
        .values({
          organization_id: organizationId,
          budget_id: budget.id,
          kind: 'soft_threshold',
          period_start: new Date('2026-08-10T00:00:00.000Z'),
          spend_micro_usd: '800000',
          limit_micro_usd: '1000000',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    },
  },
  {
    // Phase 2 RAG. `organization_id` is NULLABLE here: NULL means
    // visibility='shared' (a global playbook), non-null means visibility='tenant'.
    // The seed deliberately creates a TENANT document — a shared one is visible
    // to every organization by design, so it would make the isolation
    // assertions below vacuously false. Shared-vs-tenant behaviour is covered
    // separately in the 'RAG document visibility' block.
    table: 'capere.rag_documents',
    readable: true,
    writable: true,
    async seed(organizationId, fixture) {
      const suffix = organizationId.slice(0, 8);
      const owner = organizationId === fixture.orgAId ? fixture.userAId : fixture.userBId;

      const row = await db()
        .insertInto('capere.rag_documents')
        .values({
          organization_id: organizationId,
          visibility: 'tenant',
          title: `Tenant playbook ${suffix}`,
          source_filename: `playbook-${suffix}.md`,
          source_mime_type: 'text/markdown',
          source_bytes: '1024',
          storage_path: `rag/tenant/${organizationId}/${suffix}/playbook.md`,
          source_checksum: 'a'.repeat(64),
          created_by: owner,
          updated_by: owner,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      parentIds.set(`rag_documents:${organizationId}`, row.id);
      return row.id;
    },
    crossTenantInsert(trx, foreignOrgId) {
      return sql`
        INSERT INTO capere.rag_documents
          (organization_id, visibility, title, source_filename, source_mime_type,
           source_bytes, storage_path, source_checksum)
        VALUES (
          ${foreignOrgId}::uuid, 'tenant', 'intruder', 'intruder.md', 'text/markdown',
          1, ${`rag/tenant/${foreignOrgId}/intruder/intruder.md`}, ${'b'.repeat(64)}
        )
      `.execute(trx);
    },
  },
  {
    // Depends on rag_documents, so the parent id is captured at seed time with
    // the service client — see the note on `parentIds` above.
    table: 'capere.rag_ingestion_jobs',
    readable: true,
    writable: true,
    async seed(organizationId) {
      const documentId = parentIds.get(`rag_documents:${organizationId}`);
      if (!documentId) throw new Error('rag_documents must be seeded before rag_ingestion_jobs');

      const version = await db()
        .insertInto('capere.rag_document_versions')
        .values({
          document_id: documentId,
          version_number: 1,
          source_checksum: 'a'.repeat(64),
          parser_fingerprint: 'text-v1',
          chunker_fingerprint: 'characters-v1:1000:100',
          embedding_fingerprint: 'fake:8',
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      const row = await db()
        .insertInto('capere.rag_ingestion_jobs')
        .values({
          organization_id: organizationId,
          document_id: documentId,
          version_id: version.id,
          operation: 'ingest',
          idempotency_key: version.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      parentIds.set(`rag_versions:${organizationId}`, version.id);
      return row.id;
    },
    crossTenantInsert(trx, foreignOrgId) {
      const documentId = parentIds.get(`rag_documents:${foreignOrgId}`);
      if (!documentId) throw new Error('foreign rag_documents id was not captured');

      return sql`
        INSERT INTO capere.rag_ingestion_jobs
          (organization_id, document_id, operation, idempotency_key)
        VALUES (${foreignOrgId}::uuid, ${documentId}::uuid, 'reindex', ${`intruder-${foreignOrgId}`})
      `.execute(trx);
    },
  },
  {
    table: 'capere.rag_vector_points',
    idColumn: 'point_id',
    readable: true,
    // Vectors are an internal derived index, writable only by the service role.
    writable: false,
    async seed(organizationId) {
      const documentId = parentIds.get(`rag_documents:${organizationId}`)!;
      const versionId = parentIds.get(`rag_versions:${organizationId}`)!;
      const chunk = await db()
        .insertInto('capere.rag_chunks')
        .values({
          version_id: versionId,
          sequence: 0,
          content: `Vector isolation content for ${organizationId}`,
          content_checksum: organizationId.replaceAll('-', '').padEnd(64, '0'),
          character_count: 40,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const vector = `[1,${Array(1535).fill(0).join(',')}]`;
      await sql`
        INSERT INTO capere.rag_vector_points
          (point_id, document_id, version_id, organization_id, visibility, embedding)
        VALUES (
          ${chunk.id}::uuid, ${documentId}::uuid, ${versionId}::uuid,
          ${organizationId}::uuid, 'tenant', ${vector}::extensions.vector
        )
      `.execute(db());
      return chunk.id;
    },
  },
  {
    table: 'capere.integration_authorizations',
    readable: true,
    writable: true,
    async seed(organizationId) {
      const row = await db()
        .insertInto('capere.integration_authorizations')
        .values({
          organization_id: organizationId,
          provider: 'google',
          external_account_id: organizationId,
          encrypted_credentials: Buffer.from('test'),
          key_version: 1,
          scopes: [],
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      parentIds.set(`authorizations:${organizationId}`, row.id);
      return row.id;
    },
  },
  {
    table: 'capere.oauth_states',
    readable: true,
    writable: true,
    async seed(organizationId) {
      return (
        await db()
          .insertInto('capere.oauth_states')
          .values({
            organization_id: organizationId,
            provider: 'google',
            state_hash: `state-${organizationId}`,
            encrypted_code_verifier: Buffer.from('test'),
            redirect_uri: 'https://example.com/callback',
            requested_scopes: [],
            expires_at: new Date(Date.now() + 60000),
            consumed_at: null,
            created_by: null,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    },
  },
  {
    table: 'capere.integration_sync_states',
    readable: true,
    writable: true,
    async seed(organizationId) {
      const integrationId = parentIds.get(`integrations:${organizationId}`)!;
      return (
        await db()
          .insertInto('capere.integration_sync_states')
          .values({
            organization_id: organizationId,
            integration_id: integrationId,
            dataset: 'rls-test',
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    },
  },
  {
    table: 'capere.analytics_daily',
    readable: true,
    writable: true,
    async seed(organizationId) {
      const integrationId = parentIds.get(`integrations:${organizationId}`)!;
      return (
        await db()
          .insertInto('capere.analytics_daily')
          .values({
            organization_id: organizationId,
            integration_id: integrationId,
            provider: 'go_high_level',
            resource_id: organizationId,
            metric_date: '2026-01-01',
            metrics: JSON.stringify({ sessions: 1 }),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    },
  },
  {
    table: 'capere.gbp_reviews',
    readable: true,
    writable: true,
    async seed(organizationId) {
      const integrationId = parentIds.get(`integrations:${organizationId}`)!;
      return (
        await db()
          .insertInto('capere.gbp_reviews')
          .values({
            organization_id: organizationId,
            integration_id: integrationId,
            location_id: organizationId,
            review_id: organizationId,
            rating: 5,
            comment: null,
            reviewer_name: null,
            review_created_at: null,
            review_updated_at: null,
            reply: null,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    },
  },
  {
    table: 'capere.seo_projects',
    readable: true,
    writable: true,
    async seed(organizationId) {
      const row = await db()
        .insertInto('capere.seo_projects')
        .values({
          organization_id: organizationId,
          name: 'RLS project',
          site_url: `https://${organizationId}.example.com`,
          target_location_code: 2840,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      parentIds.set(`seo_projects:${organizationId}`, row.id);
      return row.id;
    },
  },
  {
    table: 'capere.keywords',
    readable: true,
    writable: true,
    async seed(organizationId) {
      const projectId = parentIds.get(`seo_projects:${organizationId}`)!;
      const row = await db()
        .insertInto('capere.keywords')
        .values({
          organization_id: organizationId,
          seo_project_id: projectId,
          keyword: `keyword-${organizationId}`,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      parentIds.set(`keywords:${organizationId}`, row.id);
      return row.id;
    },
  },
  {
    table: 'capere.keyword_rankings',
    readable: true,
    writable: true,
    async seed(organizationId) {
      const keywordId = parentIds.get(`keywords:${organizationId}`)!;
      return (
        await db()
          .insertInto('capere.keyword_rankings')
          .values({
            organization_id: organizationId,
            keyword_id: keywordId,
            checked_on: '2026-01-01',
            rank: 1,
            url: 'https://example.com',
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    },
  },
  {
    table: 'capere.competitors',
    readable: true,
    writable: true,
    async seed(organizationId) {
      const projectId = parentIds.get(`seo_projects:${organizationId}`)!;
      return (
        await db()
          .insertInto('capere.competitors')
          .values({
            organization_id: organizationId,
            seo_project_id: projectId,
            domain: `competitor-${organizationId}.example`,
            name: 'Competitor',
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    },
  },
  {
    table: 'capere.provider_tasks',
    readable: true,
    writable: true,
    async seed(organizationId) {
      const integrationId = parentIds.get(`integrations:${organizationId}`)!;
      const row = await db()
        .insertInto('capere.provider_tasks')
        .values({
          organization_id: organizationId,
          integration_id: integrationId,
          provider: 'data_for_seo',
          task_type: 'rls',
          request_fingerprint: `fingerprint-${organizationId}`,
          request: JSON.stringify({}),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      parentIds.set(`provider_tasks:${organizationId}`, row.id);
      return row.id;
    },
  },
  {
    table: 'capere.technical_audits',
    readable: true,
    writable: true,
    async seed(organizationId) {
      const projectId = parentIds.get(`seo_projects:${organizationId}`)!;
      const taskId = parentIds.get(`provider_tasks:${organizationId}`)!;
      return (
        await db()
          .insertInto('capere.technical_audits')
          .values({
            organization_id: organizationId,
            seo_project_id: projectId,
            provider_task_id: taskId,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    },
  },
  {
    table: 'capere.github_installations',
    readable: true,
    writable: true,
    async seed(organizationId) {
      const integrationId = parentIds.get(`integrations:${organizationId}`)!;
      const row = await db()
        .insertInto('capere.github_installations')
        .values({
          organization_id: organizationId,
          integration_id: integrationId,
          installation_id: BigInt(`0x${organizationId.replace(/-/g, '').slice(0, 12)}`).toString(),
          account_login: `org-${organizationId.slice(0, 8)}`,
          account_type: 'Organization',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      parentIds.set(`github_installations:${organizationId}`, row.id);
      return row.id;
    },
  },
  {
    table: 'capere.github_repositories',
    readable: true,
    writable: true,
    async seed(organizationId) {
      const installationId = parentIds.get(`github_installations:${organizationId}`)!;
      const row = await db()
        .insertInto('capere.github_repositories')
        .values({
          organization_id: organizationId,
          installation_id: installationId,
          repository_id: (
            BigInt(`0x${organizationId.replace(/-/g, '').slice(0, 12)}`) + 1n
          ).toString(),
          owner: 'capere',
          name: `repo-${organizationId.slice(0, 8)}`,
          default_branch: 'main',
          private: true,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      parentIds.set(`github_repositories:${organizationId}`, row.id);
      return row.id;
    },
  },
  {
    table: 'capere.github_change_requests',
    readable: true,
    writable: true,
    async seed(organizationId) {
      const repositoryId = parentIds.get(`github_repositories:${organizationId}`)!;
      return (
        await db()
          .insertInto('capere.github_change_requests')
          .values({
            organization_id: organizationId,
            repository_id: repositoryId,
            title: 'RLS change',
            base_sha: 'abcdef1',
            changes: JSON.stringify([]),
            approved_by: null,
            approved_at: null,
            branch_name: null,
            pull_request_number: null,
            pull_request_url: null,
            error: null,
            created_by: null,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    },
  },
  {
    table: 'capere.recommendations',
    readable: true,
    writable: true,
    async seed(organizationId) {
      const row = await db()
        .insertInto('capere.recommendations')
        .values({
          organization_id: organizationId,
          category: 'analytics',
          dedupe_key: `rls-${organizationId}`,
          title: 'RLS recommendation',
          rationale: 'Test rationale',
          action: 'Test action',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      parentIds.set(`recommendations:${organizationId}`, row.id);
      return row.id;
    },
    crossTenantInsert(trx, foreignOrgId) {
      return sql`
        INSERT INTO capere.recommendations
          (organization_id, category, dedupe_key, title, rationale, action)
        VALUES (${foreignOrgId}::uuid, 'analytics', 'intruder', 'intruder', 'intruder', 'intruder')
      `.execute(trx);
    },
  },
  {
    table: 'capere.recommendation_history',
    readable: true,
    writable: true,
    async seed(organizationId) {
      const recommendationId = parentIds.get(`recommendations:${organizationId}`)!;
      return (
        await db()
          .insertInto('capere.recommendation_history')
          .values({
            organization_id: organizationId,
            recommendation_id: recommendationId,
            to_status: 'proposed',
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    },
    crossTenantInsert(trx, foreignOrgId) {
      const parentId = parentIds.get(`recommendations:${foreignOrgId}`)!;
      return sql`
        INSERT INTO capere.recommendation_history
          (organization_id, recommendation_id, to_status)
        VALUES (${foreignOrgId}::uuid, ${parentId}::uuid, 'proposed')
      `.execute(trx);
    },
  },
  {
    table: 'capere.dashboard_metrics',
    readable: true,
    writable: true,
    async seed(organizationId) {
      const row = await db()
        .insertInto('capere.dashboard_metrics')
        .values({
          organization_id: organizationId,
          dashboard: 'executive',
          metric_date: '2026-08-04',
          metric_name: 'sessions',
          metric_value: '1',
          source: 'rls-test',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    },
    crossTenantInsert(trx, foreignOrgId) {
      return sql`
        INSERT INTO capere.dashboard_metrics
          (organization_id, dashboard, metric_date, metric_name, metric_value, source)
        VALUES (${foreignOrgId}::uuid, 'executive', '2026-08-05', 'intruder', 1, 'rls-test')
      `.execute(trx);
    },
  },
  {
    table: 'capere.executive_reports',
    readable: true,
    writable: true,
    async seed(organizationId) {
      const row = await db()
        .insertInto('capere.executive_reports')
        .values({
          organization_id: organizationId,
          period_start: '2026-08-01',
          period_end: '2026-08-07',
          title: 'RLS report',
          content: 'test',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    },
    crossTenantInsert(trx, foreignOrgId) {
      return sql`
        INSERT INTO capere.executive_reports
          (organization_id, period_start, period_end, title, content)
        VALUES (${foreignOrgId}::uuid, '2026-08-08', '2026-08-14', 'intruder', 'intruder')
      `.execute(trx);
    },
  },
  {
    table: 'capere.automation_actions',
    readable: true,
    writable: true,
    async seed(organizationId) {
      return (
        await db()
          .insertInto('capere.automation_actions')
          .values({
            organization_id: organizationId,
            integration_id: parentIds.get(`integrations:${organizationId}`)!,
            kind: 'ghl_task_create',
            title: 'RLS action',
            payload: JSON.stringify({ contactId: 'c1', title: 'Follow up' }),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    },
    crossTenantInsert(trx, foreignOrgId) {
      return sql`INSERT INTO capere.automation_actions (organization_id, integration_id, kind, title, payload)
        VALUES (${foreignOrgId}::uuid, ${parentIds.get(`integrations:${foreignOrgId}`)!}::uuid, 'ghl_task_create', 'intruder', '{}'::jsonb)`.execute(
        trx,
      );
    },
  },
  {
    table: 'capere.generated_artifacts',
    readable: true,
    writable: true,
    async seed(organizationId) {
      return (
        await db()
          .insertInto('capere.generated_artifacts')
          .values({
            organization_id: organizationId,
            kind: 'daily_brief',
            artifact_date: '2026-08-04',
            title: 'RLS brief',
            content: 'test',
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    },
    crossTenantInsert(trx, foreignOrgId) {
      return sql`INSERT INTO capere.generated_artifacts (organization_id, kind, artifact_date, title, content)
        VALUES (${foreignOrgId}::uuid, 'daily_brief', '2026-08-05', 'intruder', 'intruder')`.execute(
        trx,
      );
    },
  },
];

describe('Row-Level Security — cross-tenant isolation', () => {
  let fixture: Fixture;
  /** table -> { orgA row id, orgB row id } */
  const seeded = new Map<string, { a: string; b: string }>();

  beforeAll(async () => {
    fixture = await seedTwoOrganizations();

    for (const spec of TENANT_TABLES) {
      const a = await spec.seed(fixture.orgAId, fixture);
      const b = await spec.seed(fixture.orgBId, fixture);
      seeded.set(spec.table, { a, b });
    }

    // conversation_messages needs a parent session, so it is seeded separately.
    const sessions = seeded.get('capere.ai_sessions');
    if (!sessions) throw new Error('ai_sessions must be seeded first');

    const messageA = await serviceDb()
      .insertInto('capere.conversation_messages')
      .values({
        session_id: sessions.a,
        organization_id: fixture.orgAId,
        role: 'user',
        content: 'How is my SEO doing?',
        sequence: 1,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const messageB = await serviceDb()
      .insertInto('capere.conversation_messages')
      .values({
        session_id: sessions.b,
        organization_id: fixture.orgBId,
        role: 'user',
        content: 'Confidential org B question',
        sequence: 1,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    seeded.set('capere.conversation_messages', { a: messageA.id, b: messageB.id });
  });

  afterAll(async () => {
    await cleanup(fixture);
    await closeDb();
  });

  // --- The mechanism itself -------------------------------------------------

  describe('the RLS mechanism', () => {
    it('resolves auth.uid() from transaction-local JWT claims', async () => {
      const resolved = await asUser(fixture.userAId, async (trx) => {
        const result = await sql<{ uid: string | null }>`SELECT auth.uid() AS uid`.execute(trx);
        return result.rows[0].uid;
      });

      expect(resolved).toBe(fixture.userAId);
    });

    it('sees nothing when no JWT claims are set', async () => {
      // Proves visibility comes from the claims, not from the connection.
      const visible = await asAnonymous(async (trx) => {
        const result = await sql<{ count: string }>`
          SELECT count(*)::text AS count FROM capere.organizations
        `.execute(trx);
        return Number(result.rows[0].count);
      });

      expect(visible).toBe(0);
    });

    it('does not leak claims across transactions', async () => {
      // set_config(..., true) is transaction-local; a pooled connection reused
      // by the next request must not inherit the previous identity.
      await asUser(fixture.userAId, async (trx) => {
        const result = await sql<{ uid: string | null }>`SELECT auth.uid() AS uid`.execute(trx);
        expect(result.rows[0].uid).toBe(fixture.userAId);
      });

      const leaked = await asAnonymous(async (trx) => {
        const result = await sql<{ uid: string | null }>`SELECT auth.uid() AS uid`.execute(trx);
        return result.rows[0].uid;
      });

      expect(leaked).toBeNull();
    });
  });

  // --- Core tenancy tables --------------------------------------------------

  describe('organizations', () => {
    it('shows a member only their own organization', async () => {
      const rows = await asUser(fixture.userAId, (trx) =>
        trx.selectFrom('capere.organizations').select('id').execute(),
      );

      const ids = rows.map((r) => r.id);
      expect(ids).toContain(fixture.orgAId);
      expect(ids).not.toContain(fixture.orgBId);
    });

    it('refuses to update another organization', async () => {
      await asUser(fixture.userAId, async (trx) => {
        const result = await trx
          .updateTable('capere.organizations')
          .set({ name: 'Hijacked' })
          .where('id', '=', fixture.orgBId)
          .executeTakeFirst();

        expect(Number(result.numUpdatedRows)).toBe(0);
      });

      const orgB = await serviceDb()
        .selectFrom('capere.organizations')
        .select('name')
        .where('id', '=', fixture.orgBId)
        .executeTakeFirstOrThrow();

      expect(orgB.name).not.toBe('Hijacked');
    });
  });

  describe('organization_members', () => {
    it("shows only the roster of the caller's own organization", async () => {
      const rows = await asUser(fixture.userAId, (trx) =>
        trx
          .selectFrom('capere.organization_members')
          .select(['organization_id', 'user_id'])
          .execute(),
      );

      expect(rows.every((r) => r.organization_id === fixture.orgAId)).toBe(true);
      expect(rows.some((r) => r.user_id === fixture.userBId)).toBe(false);
    });

    it('refuses to add the caller to another organization', async () => {
      // The classic privilege-escalation attempt: grant yourself membership.
      await expect(
        asUser(fixture.userAId, (trx) =>
          trx
            .insertInto('capere.organization_members')
            .values({
              organization_id: fixture.orgBId,
              user_id: fixture.userAId,
              role: 'owner',
            })
            .execute(),
        ),
      ).rejects.toThrow();
    });
  });

  describe('users', () => {
    it('does not expose users from other organizations', async () => {
      const rows = await asUser(fixture.userAId, (trx) =>
        trx.selectFrom('capere.users').select('id').execute(),
      );

      const ids = rows.map((r) => r.id);
      expect(ids).toContain(fixture.userAId);
      expect(ids).not.toContain(fixture.userBId);
    });
  });

  // --- Every tenant-scoped table -------------------------------------------

  describe.each(TENANT_TABLES.map((spec) => [spec.table, spec] as const))('%s', (table, spec) => {
    it("shows the caller their own organization's row", async () => {
      if (!spec.readable) return;
      const ids = seeded.get(table);
      if (!ids) throw new Error(`${table} was not seeded`);
      const idColumn = spec.idColumn ?? 'id';

      const count = await asUser(fixture.userAId, async (trx) => {
        const result = await sql<{ count: string }>`
            SELECT count(*)::text AS count
            FROM ${sql.raw(table)}
            WHERE ${sql.raw(idColumn)} = ${ids.a}::uuid
          `.execute(trx);
        return Number(result.rows[0].count);
      });

      expect(count).toBe(1);
    });

    it("hides the other organization's row", async () => {
      const ids = seeded.get(table);
      if (!ids) throw new Error(`${table} was not seeded`);
      const idColumn = spec.idColumn ?? 'id';

      const count = await asUser(fixture.userAId, async (trx) => {
        const result = await sql<{ count: string }>`
            SELECT count(*)::text AS count
            FROM ${sql.raw(table)}
            WHERE ${sql.raw(idColumn)} = ${ids.b}::uuid
          `.execute(trx);
        return Number(result.rows[0].count);
      });

      expect(count).toBe(0);
    });

    it("refuses to delete the other organization's row", async () => {
      const ids = seeded.get(table);
      if (!ids) throw new Error(`${table} was not seeded`);
      const idColumn = spec.idColumn ?? 'id';

      await asUser(fixture.userAId, async (trx) => {
        await sql`DELETE FROM ${sql.raw(table)} WHERE ${sql.raw(idColumn)} = ${ids.b}::uuid`.execute(
          trx,
        );
      });

      // Verify with the service client that the row genuinely survived.
      const survived = await sql<{ count: string }>`
          SELECT count(*)::text AS count
          FROM ${sql.raw(table)}
          WHERE ${sql.raw(idColumn)} = ${ids.b}::uuid
        `.execute(serviceDb());

      expect(Number(survived.rows[0].count)).toBe(1);
    });

    it("refuses to insert a row stamped with the other organization's id", async () => {
      const attempt = spec.crossTenantInsert;
      if (!spec.writable || !attempt) return;

      // The insert must be rejected by a TENANCY control, and the assertion is
      // deliberately specific: a bare `.rejects.toThrow()` would also pass on a
      // NOT NULL or type error, proving nothing about isolation.
      //
      // Two distinct mechanisms can legitimately fire, and which one wins
      // depends on the table:
      //
      //   1. RLS WITH CHECK — "new row violates row-level security policy".
      //   2. A security-definer integrity trigger (migration 0008's
      //      `enforce_rag_job_organization`) that resolves the parent document
      //      through an RLS-scoped SELECT. Because the foreign parent is
      //      invisible to this user, the trigger reports "does not exist" and
      //      raises BEFORE the row is ever checked against the policy.
      //
      // Both are correct rejections of a cross-tenant write. Accepting only the
      // first would make the stricter, earlier-firing control look like a
      // failure.
      await expect(asUser(fixture.userAId, (trx) => attempt(trx, fixture.orgBId))).rejects.toThrow(
        /violates row-level security policy|does not exist|organization must match/i,
      );
    });
  });

  // --- Non-tenant tables ----------------------------------------------------

  describe('RAG document visibility', () => {
    // The generic table loop cannot express this: it asserts that org B's rows
    // are ALWAYS invisible to org A, which is correct for tenant documents but
    // deliberately wrong for shared ones. A shared playbook is meant to be
    // readable by every organization while remaining writable by nobody except
    // a capere_admin — that asymmetry is the entire point of the `visibility`
    // column, and it is the part most likely to be broken by a future policy
    // edit.
    let sharedDocumentId: string;

    beforeAll(async () => {
      const row = await serviceDb()
        .insertInto('capere.rag_documents')
        .values({
          organization_id: null,
          visibility: 'shared',
          title: 'Shared CPA playbook',
          source_filename: 'cpa-playbook.md',
          source_mime_type: 'text/markdown',
          source_bytes: '2048',
          storage_path: `rag/shared/${fixture.orgAId.slice(0, 8)}/v1/cpa-playbook.md`,
          source_checksum: 'c'.repeat(64),
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      sharedDocumentId = row.id;
    });

    afterAll(async () => {
      await serviceDb()
        .deleteFrom('capere.rag_documents')
        .where('id', '=', sharedDocumentId)
        .execute();
    });

    it('makes a shared document readable by BOTH organizations', async () => {
      for (const userId of [fixture.userAId, fixture.userBId]) {
        const visible = await asUser(userId, async (trx) => {
          const result = await sql<{ count: string }>`
            SELECT count(*)::text AS count
            FROM capere.rag_documents
            WHERE id = ${sharedDocumentId}::uuid
          `.execute(trx);
          return Number(result.rows[0].count);
        });

        expect(visible, `shared document should be visible to ${userId}`).toBe(1);
      }
    });

    it('keeps a tenant document readable by only its own organization', async () => {
      const orgADocument = parentIds.get(`rag_documents:${fixture.orgAId}`);
      if (!orgADocument) throw new Error('rag_documents was not seeded for org A');

      const seenByOwner = await asUser(fixture.userAId, async (trx) => {
        const result = await sql<{ count: string }>`
          SELECT count(*)::text AS count
          FROM capere.rag_documents WHERE id = ${orgADocument}::uuid
        `.execute(trx);
        return Number(result.rows[0].count);
      });

      const seenByOther = await asUser(fixture.userBId, async (trx) => {
        const result = await sql<{ count: string }>`
          SELECT count(*)::text AS count
          FROM capere.rag_documents WHERE id = ${orgADocument}::uuid
        `.execute(trx);
        return Number(result.rows[0].count);
      });

      expect(seenByOwner).toBe(1);
      expect(seenByOther).toBe(0);
    });

    it('refuses to let a non-admin member modify a shared document', async () => {
      // Both fixture users are `owner` of their own organization, not
      // `capere_admin`. Owning an organization must not confer edit rights over
      // the global playbook every other firm also reads.
      await asUser(fixture.userAId, async (trx) => {
        await sql`
          UPDATE capere.rag_documents
          SET title = 'Hijacked shared playbook'
          WHERE id = ${sharedDocumentId}::uuid
        `.execute(trx);
      });

      const after = await serviceDb()
        .selectFrom('capere.rag_documents')
        .select('title')
        .where('id', '=', sharedDocumentId)
        .executeTakeFirstOrThrow();

      expect(after.title).toBe('Shared CPA playbook');
    });

    it('refuses to let a non-admin member create a shared document', async () => {
      await expect(
        asUser(fixture.userAId, async (trx) => {
          await sql`
            INSERT INTO capere.rag_documents
              (organization_id, visibility, title, source_filename, source_mime_type,
               source_bytes, storage_path, source_checksum)
            VALUES (
              NULL, 'shared', 'Unauthorized shared doc', 'x.md', 'text/markdown',
              1, ${`rag/shared/intruder-${fixture.orgAId.slice(0, 8)}/v1/x.md`}, ${'d'.repeat(64)}
            )
          `.execute(trx);
        }),
      ).rejects.toThrow(/violates row-level security policy/i);
    });
  });

  describe('coverage completeness', () => {
    it('asserts isolation for every table that has an organization_id column', async () => {
      // A meta-test, and the reason the earlier gap is now hard to reintroduce:
      // conversation_messages was seeded but never asserted, so the table
      // holding AI transcripts had ZERO isolation coverage while the suite
      // looked green. This queries the live schema instead of trusting a
      // hand-maintained list, so adding a tenant table without a policy test
      // fails here rather than shipping silently.
      const result = await sql<{ table_name: string }>`
        SELECT c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid
        WHERE n.nspname = 'capere'
          AND c.relkind = 'r'
          AND a.attname = 'organization_id'
          AND a.attnum > 0
          AND NOT a.attisdropped
        ORDER BY c.relname
      `.execute(serviceDb());

      const withOrgColumn = result.rows.map((r) => `capere.${r.table_name}`);
      const covered = new Set(TENANT_TABLES.map((t) => t.table));

      // organizations and organization_members are covered by their own
      // dedicated describe blocks above, not by the table-driven loop.
      const exempt = new Set(['capere.organizations', 'capere.organization_members']);

      const uncovered = withOrgColumn.filter((t) => !covered.has(t) && !exempt.has(t));

      expect(
        uncovered,
        `These tenant-scoped tables have no RLS isolation test. Add them to ` +
          `TENANT_TABLES:\n  ${uncovered.join('\n  ')}`,
      ).toEqual([]);
    });
  });

  describe('global tables', () => {
    it('exposes the prompt template catalog to every authenticated user', async () => {
      const rows = await asUser(fixture.userAId, (trx) =>
        trx.selectFrom('capere.prompt_templates').select('id').execute(),
      );
      expect(Array.isArray(rows)).toBe(true);
    });

    it('hides system_logs from organization members', async () => {
      const count = await asUser(fixture.userAId, async (trx) => {
        const result = await sql<{ count: string }>`
          SELECT count(*)::text AS count FROM capere.system_logs
        `.execute(trx);
        return Number(result.rows[0].count);
      });

      // Policy grants SELECT to service_role only.
      expect(count).toBe(0);
    });
  });
});
