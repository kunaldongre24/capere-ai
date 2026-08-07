import type { AppConfig } from '../shared/config';
import type { SemanticHit } from '../intelligence/memory/memory.interface';
import type { VectorRecord, VectorStore } from './vector-store.port';

interface QdrantSearchResponse {
  result?: Array<{ score?: number; payload?: Record<string, unknown> }>;
}

export class QdrantVectorStore implements VectorStore {
  readonly available: boolean;

  /**
   * Cached liveness, so `isReachable()` on every search does not add a round
   * trip per query. The TTL is short because the cost of being wrong is
   * asymmetric: briefly claiming the store is up when it just died degrades one
   * answer, while claiming it is down when it recovered only loses retrieval
   * for a few seconds.
   */
  private reachableCache?: { value: boolean; expiresAt: number };
  private static readonly REACHABILITY_TTL_MS = 10_000;

  constructor(private readonly config: AppConfig) {
    this.available = Boolean(config.qdrant.url);
  }

  async isReachable(): Promise<boolean> {
    if (!this.available) return false;

    const cached = this.reachableCache;
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    let value = false;
    try {
      // Probes the COLLECTION, not just the server: a running Qdrant with no
      // collection returns nothing for every search, which is indistinguishable
      // from "the playbook contains no answer" unless we check specifically.
      const response = await this.request(`/collections/${this.config.qdrant.collection}`, {
        method: 'GET',
      });
      value = response.ok;
    } catch {
      value = false;
    }

    this.reachableCache = { value, expiresAt: Date.now() + QdrantVectorStore.REACHABILITY_TTL_MS };
    return value;
  }

  async ensureCollection(dimensions: number): Promise<void> {
    const response = await this.request(`/collections/${this.config.qdrant.collection}`, {
      method: 'GET',
    });
    if (response.status === 404) {
      const created = await this.request(`/collections/${this.config.qdrant.collection}`, {
        method: 'PUT',
        body: JSON.stringify({ vectors: { size: dimensions, distance: 'Cosine' } }),
      });
      if (!created.ok) throw new Error(`Qdrant collection creation failed with ${created.status}`);
      await this.ensurePayloadIndexes();
      // The collection now exists, so a cached "unreachable" verdict is stale.
      this.reachableCache = undefined;
      return;
    }
    if (!response.ok) throw new Error(`Qdrant collection check failed with ${response.status}`);
    const body = (await response.json()) as {
      result?: { config?: { params?: { vectors?: { size?: number } } } };
    };
    const actual = body.result?.config?.params?.vectors?.size;
    if (actual !== dimensions) {
      throw new Error(
        `Qdrant collection dimension ${actual ?? 'unknown'} does not match ${dimensions}`,
      );
    }
    await this.ensurePayloadIndexes();
  }

  async upsert(records: readonly VectorRecord[], assertLease?: () => Promise<void>): Promise<void> {
    if (records.length === 0) return;
    await assertLease?.();
    const response = await this.request(
      `/collections/${this.config.qdrant.collection}/points?wait=true`,
      {
        method: 'PUT',
        body: JSON.stringify({
          points: records.map((record) => ({
            id: record.pointId,
            vector: record.vector,
            payload: {
              document_id: record.payload.documentId,
              version_id: record.payload.versionId,
              chunk_id: record.payload.chunkId,
              visibility: record.payload.visibility,
              organization_id: record.payload.organizationId,
              title: record.payload.title,
              source: record.payload.source,
              section: record.payload.section,
              content: record.payload.content,
              checksum: record.payload.checksum,
            },
          })),
        }),
      },
    );
    if (!response.ok) throw new Error(`Qdrant upsert failed with ${response.status}`);
  }

  async search(params: {
    organizationId: string;
    vector: readonly number[];
    limit: number;
    minScore?: number;
  }): Promise<SemanticHit[]> {
    const response = await this.request(
      `/collections/${this.config.qdrant.collection}/points/search`,
      {
        method: 'POST',
        body: JSON.stringify({
          vector: params.vector,
          limit: params.limit,
          score_threshold: params.minScore,
          with_payload: true,
          filter: {
            should: [
              { key: 'visibility', match: { value: 'shared' } },
              {
                must: [
                  { key: 'visibility', match: { value: 'tenant' } },
                  { key: 'organization_id', match: { value: params.organizationId } },
                ],
              },
            ],
          },
        }),
      },
    );
    if (!response.ok) throw new Error(`Qdrant search failed with ${response.status}`);
    const body = (await response.json()) as QdrantSearchResponse;
    return (body.result ?? []).map((item) => {
      const payload = item.payload ?? {};
      return {
        documentId: String(payload.document_id),
        chunkId: String(payload.chunk_id),
        content: String(payload.content),
        score: item.score ?? 0,
        citation: {
          title: String(payload.title),
          source: typeof payload.source === 'string' ? payload.source : undefined,
          section: typeof payload.section === 'string' ? payload.section : undefined,
        },
      };
    });
  }

  async deleteDocument(documentId: string): Promise<void> {
    await this.deleteByFilter({ key: 'document_id', value: documentId }, 'document');
  }

  /**
   * Removes every point for one version.
   *
   * Needed before re-upserting: chunk ids are deterministic per (version,
   * sequence), so a re-ingest overwrites points in place — but if the new run
   * produces FEWER chunks, the tail points from the previous run would survive
   * and keep serving text that no longer exists in the source document.
   */
  async deleteVersion(versionId: string): Promise<void> {
    await this.deleteByFilter({ key: 'version_id', value: versionId }, 'version');
  }

  private async deleteByFilter(
    match: { key: string; value: string },
    label: string,
  ): Promise<void> {
    const response = await this.request(
      `/collections/${this.config.qdrant.collection}/points/delete?wait=true`,
      {
        method: 'POST',
        body: JSON.stringify({
          filter: { must: [{ key: match.key, match: { value: match.value } }] },
        }),
      },
    );
    // A missing collection means there is nothing to delete — that is success,
    // not failure, and treating it as an error would make the first ingest of a
    // fresh deployment fail.
    if (response.status === 404) return;
    if (!response.ok) {
      throw new Error(`Qdrant ${label} delete failed with ${response.status}`);
    }
  }

  private async ensurePayloadIndexes(): Promise<void> {
    // Qdrant Cloud requires indexes for fields used in filters. Provisioning is
    // idempotent, so this also repairs collections created by older releases.
    for (const fieldName of ['visibility', 'organization_id', 'document_id', 'version_id']) {
      const response = await this.request(
        `/collections/${this.config.qdrant.collection}/index?wait=true`,
        {
          method: 'PUT',
          body: JSON.stringify({ field_name: fieldName, field_schema: 'keyword' }),
        },
      );
      if (!response.ok) {
        throw new Error(
          `Qdrant payload index creation failed for ${fieldName}: ${response.status}`,
        );
      }
    }
  }

  private request(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('content-type', 'application/json');
    if (this.config.qdrant.apiKey) headers.set('api-key', this.config.qdrant.apiKey);
    return fetch(`${this.config.qdrant.url.replace(/\/$/, '')}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(this.config.qdrant.timeoutMs),
    });
  }
}
