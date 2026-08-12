import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { DatabaseService } from '../shared/database';
import { RagLeaseLostError, RagService, type RagLease } from './rag.service';

interface ClaimedRagJob {
  readonly id: string;
  readonly document_id: string;
  readonly version_id: string | null;
  readonly operation: 'ingest' | 'reindex' | 'delete';
  readonly attempts: number;
  readonly max_attempts: number;
  readonly claimToken: string;
}

@Injectable()
export class RagIngestionWorker {
  private static readonly HEARTBEAT_MS = 60_000;
  private readonly logger = new Logger(RagIngestionWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopping = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly rag: RagService,
  ) {}

  start(intervalMs = 2_000): void {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 25));
  }

  async tick(): Promise<boolean> {
    if (this.running || this.stopping) return false;
    this.running = true;
    try {
      const job = await this.claim();
      if (!job) return false;
      try {
        await this.withLeaseHeartbeat(job, async (assertLease) => {
          if (job.operation === 'delete') {
            await this.rag.purge(job.document_id, this.lease(job, assertLease));
          } else {
            if (!job.version_id) throw new Error('Ingestion job has no document version');
            await this.rag.ingest(job.document_id, job.version_id, this.lease(job, assertLease));
          }
          await this.succeed(job);
        });
      } catch (error) {
        if (error instanceof RagLeaseLostError) {
          this.logger.warn(error.message);
          return false;
        }
        await this.fail(job, error);
      }
      return true;
    } catch (error) {
      this.logger.error(
        `RAG worker tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
    return false;
  }

  private async claim(): Promise<ClaimedRagJob | undefined> {
    return this.database.transaction(async (trx) => {
      const result = await sql<{
        id: string;
        document_id: string;
        version_id: string | null;
        operation: 'ingest' | 'reindex' | 'delete';
        attempts: number;
        max_attempts: number;
      }>`
        SELECT id, document_id, version_id, operation, attempts, max_attempts
        FROM capere.rag_ingestion_jobs
        WHERE status IN ('queued', 'failed', 'running')
          AND attempts < max_attempts
          AND (next_retry_at IS NULL OR next_retry_at <= now())
          AND (status <> 'running' OR lease_until < now())
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `.execute(trx);
      const job = result.rows[0];
      if (!job) return undefined;
      const claimToken = randomUUID();
      await trx
        .updateTable('capere.rag_ingestion_jobs')
        .set({
          status: 'running',
          attempts: job.attempts + 1,
          claimed_by: claimToken,
          lease_until: sql`now() + interval '5 minutes'`,
          error_message: null,
        })
        .where('id', '=', job.id)
        .execute();
      return { ...job, attempts: job.attempts + 1, claimToken };
    });
  }

  private async succeed(job: ClaimedRagJob): Promise<void> {
    const result = await this.database.db
      .updateTable('capere.rag_ingestion_jobs')
      .set({ status: 'succeeded', error_message: null, lease_until: null, claimed_by: null })
      .where('id', '=', job.id)
      .where('status', '=', 'running')
      .where('claimed_by', '=', job.claimToken)
      .execute();
    if (result[0]?.numUpdatedRows !== 1n) throw new RagLeaseLostError(job.id);
  }

  private async fail(job: ClaimedRagJob, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const exhausted = job.attempts >= job.max_attempts;
    await this.database.transaction(async (trx) => {
      const claimed = await trx
        .updateTable('capere.rag_ingestion_jobs')
        .set({
          status: exhausted ? 'dead_lettered' : 'failed',
          next_retry_at: exhausted ? null : new Date(Date.now() + 5_000 * 2 ** (job.attempts - 1)),
          lease_until: null,
          claimed_by: null,
          error_message: message,
        })
        .where('id', '=', job.id)
        .where('status', '=', 'running')
        .where('claimed_by', '=', job.claimToken)
        .returning('id')
        .executeTakeFirst();
      if (!claimed) throw new RagLeaseLostError(job.id);
      await trx
        .updateTable('capere.rag_documents')
        .set({ status: 'failed', error_message: message })
        // A delete job that fails partway has already marked the document
        // 'deleted' inside purge(), and its content really is gone. Flipping it
        // back to 'failed' would misreport a purged document as a broken one,
        // and would resurrect it into list() results.
        .where('status', '!=', 'deleted')
        .where('id', '=', job.document_id)
        .execute();
      if (job.version_id) {
        await trx
          .updateTable('capere.rag_document_versions')
          .set({ status: 'failed', error_message: message })
          .where('id', '=', job.version_id)
          .execute();
      }
    });
    this.logger.warn(`RAG job ${job.id} failed (${job.attempts}/${job.max_attempts}): ${message}`);
  }

  private async withLeaseHeartbeat<T>(
    job: ClaimedRagJob,
    work: (assertLease: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    let lost = false;
    let renewal: Promise<void> = Promise.resolve();
    const renew = async (): Promise<void> => {
      const result = await this.database.db
        .updateTable('capere.rag_ingestion_jobs')
        .set({ lease_until: sql`now() + interval '5 minutes'` })
        .where('id', '=', job.id)
        .where('status', '=', 'running')
        .where('claimed_by', '=', job.claimToken)
        .execute();
      if (result[0]?.numUpdatedRows !== 1n) {
        lost = true;
        throw new RagLeaseLostError(job.id);
      }
    };
    const assertLease = async (): Promise<void> => {
      if (lost) throw new RagLeaseLostError(job.id);
      await renew();
    };
    const timer = setInterval(() => {
      renewal = renewal.then(renew).catch((error: unknown) => {
        lost = true;
        this.logger.warn(
          `Could not renew RAG job ${job.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, RagIngestionWorker.HEARTBEAT_MS);
    timer.unref();

    try {
      await assertLease();
      return await work(assertLease);
    } finally {
      clearInterval(timer);
      await renewal;
    }
  }

  private lease(job: ClaimedRagJob, assert: () => Promise<void>): RagLease {
    return { jobId: job.id, claimToken: job.claimToken, assert };
  }
}
