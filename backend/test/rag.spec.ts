import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/shared/config/app-config';
import { chunkText, normalizeSourceText } from '../src/rag/chunking';
import { FakeEmbeddingProvider } from '../src/rag/fake-embedding.provider';
import { QdrantSemanticMemory } from '../src/rag/qdrant-semantic.memory';
import { QdrantVectorStore } from '../src/rag/qdrant-vector.store';
import { storagePath } from '../src/rag/source-storage';

function config() {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://postgres:password@localhost:5432/postgres',
    REDIS_URL: 'redis://localhost:6379',
    API_KEYS_HASHING_SALT: 'test-salt-0123456789abcdef',
    KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    VECTOR_STORE_PROVIDER: 'qdrant',
    QDRANT_URL: 'http://qdrant.test:6333',
    QDRANT_COLLECTION: 'test-rag',
    RAG_EMBEDDING_DIMENSIONS: '4',
  });
}

afterEach(() => vi.restoreAllMocks());

describe('RAG text pipeline', () => {
  it('normalizes HTML without retaining scripts or tags', () => {
    expect(
      normalizeSourceText(
        '<h1>Tax Planning</h1><script>steal()</script><p>A &amp; B</p>',
        'text/html',
      ),
    ).toBe('Tax Planning A & B');
  });

  it('produces stable bounded chunks with overlap', () => {
    const input = 'alpha '.repeat(100);
    const first = chunkText(input, {
      targetCharacters: 128,
      overlapCharacters: 20,
      maxChunks: 20,
    });
    const second = chunkText(input, {
      targetCharacters: 128,
      overlapCharacters: 20,
      maxChunks: 20,
    });
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(1);
    expect(first.every((chunk) => chunk.characterCount <= 128)).toBe(true);
  });

  it('rejects documents above the configured chunk bound', () => {
    expect(() =>
      chunkText('word '.repeat(500), {
        targetCharacters: 128,
        overlapCharacters: 20,
        maxChunks: 1,
      }),
    ).toThrow(/maximum of 1 chunks/);
  });
});

describe('RAG infrastructure adapters', () => {
  it('builds trusted tenant and shared storage paths', () => {
    expect(
      storagePath({
        organizationId: 'org-id',
        documentId: 'document-id',
        versionId: 'version-id',
        filename: '../../tax plan?.md',
      }),
    ).toBe('rag/organizations/org-id/document-id/version-id/.._.._tax_plan_.md');
    expect(
      storagePath({
        organizationId: null,
        documentId: 'document-id',
        versionId: 'version-id',
        filename: 'guide.md',
      }),
    ).toBe('rag/shared/document-id/version-id/guide.md');
  });

  it('returns deterministic fake embeddings with the configured dimensions', async () => {
    const provider = new FakeEmbeddingProvider(4);
    const first = await provider.embed(['quarterly tax planning']);
    const second = await provider.embed(['quarterly tax planning']);
    expect(first.vectors).toEqual(second.vectors);
    expect(first.vectors[0]).toHaveLength(4);
    expect(first.usage.costMicroUsd).toBe(0);
  });

  it('sends shared-or-same-tenant filtering to Qdrant', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ result: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const store = new QdrantVectorStore(config());
    await store.search({ organizationId: 'org-a', vector: [1, 0, 0, 0], limit: 5 });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body)) as {
      filter: { should: Array<Record<string, unknown>> };
    };
    expect(body.filter.should).toEqual([
      { key: 'visibility', match: { value: 'shared' } },
      {
        must: [
          { key: 'visibility', match: { value: 'tenant' } },
          { key: 'organization_id', match: { value: 'org-a' } },
        ],
      },
    ]);
  });

  it('provisions every payload index required by filtered operations', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ result: { config: { params: { vectors: { size: 4 } } } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const store = new QdrantVectorStore(config());

    await store.ensureCollection(4);

    const indexBodies = fetchMock.mock.calls
      .slice(1)
      .map(
        ([, init]) =>
          JSON.parse(String(init?.body)) as { field_name: string; field_schema: string },
      );
    expect(indexBodies).toEqual(
      ['visibility', 'organization_id', 'document_id', 'version_id'].map((field_name) => ({
        field_name,
        field_schema: 'keyword',
      })),
    );
  });
});

/**
 * THE FABRICATION GUARD.
 *
 * `MemorySnapshot.semanticAvailable` decides whether the Hermes context builder
 * tells the model "the CPA playbook and SOP knowledge base is not available".
 * If that reports `true` while Qdrant is down, the model believes it searched
 * the playbook, found nothing, and answers confidently from its own priors —
 * producing a fabricated procedure that reads exactly like a grounded one.
 *
 * This was a real defect: `QdrantSemanticMemory.available` was hardcoded `true`,
 * which made the working implementation LESS safe than the null one it replaced.
 */
describe('semantic availability reporting', () => {
  function memory(store: QdrantVectorStore): QdrantSemanticMemory {
    return new QdrantSemanticMemory(new FakeEmbeddingProvider(4), store);
  }

  it('reports unreachable when Qdrant refuses the connection', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const store = new QdrantVectorStore(config());

    await expect(store.isReachable()).resolves.toBe(false);
    await expect(memory(store).isAvailable()).resolves.toBe(false);
  });

  it('reports unreachable when the collection does not exist', async () => {
    // A running Qdrant with no collection returns nothing for every search,
    // which is indistinguishable from "the playbook has no answer" unless the
    // collection is probed specifically.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 404 }));
    const store = new QdrantVectorStore(config());

    await expect(store.isReachable()).resolves.toBe(false);
  });

  it('reports reachable when the collection answers', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ result: { config: {} } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const store = new QdrantVectorStore(config());

    await expect(store.isReachable()).resolves.toBe(true);
  });

  it('caches the probe so search does not pay a round trip per query', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ result: { config: {} } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const store = new QdrantVectorStore(config());

    await store.isReachable();
    await store.isReachable();
    await store.isReachable();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws rather than returning empty when the store is unreachable', async () => {
    // Throwing is what lets MemoryService flip `semanticAvailable` to false in
    // its catch block. Returning [] would look identical to a successful search
    // with no matches — the exact ambiguity that causes the fabrication.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const store = new QdrantVectorStore(config());

    await expect(
      memory(store).search({ organizationId: 'org-a', query: 'what is our tax deadline policy?' }),
    ).rejects.toThrow(/unreachable|not reachable|collection does not exist/i);
  });

  it('treats a configured-but-dead store as unavailable, not as an empty playbook', async () => {
    // NOTE: `QDRANT_URL` is `z.string().url()` with a default, so "no URL
    // configured" is unreachable through config — `available` is effectively
    // always true for this adapter. That makes `isReachable()` the only
    // meaningful signal, which is precisely why `available` alone was not
    // sufficient to guard against fabrication.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }));
    const store = new QdrantVectorStore(config());

    expect(store.available).toBe(true);
    await expect(store.isReachable()).resolves.toBe(false);
    await expect(memory(store).isAvailable()).resolves.toBe(false);
  });
});

describe('re-ingest vector hygiene', () => {
  it("deletes a version's points before re-upserting", async () => {
    // Regression test for orphaned vectors. Chunk ids are deterministic per
    // (version, sequence), so chunks 0..n-1 overwrite in place — but a re-ingest
    // that produces FEWER chunks would leave the tail points serving text that
    // is no longer in the source document.
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ result: {} }), { status: 200 }));
    const store = new QdrantVectorStore(config());

    await store.deleteVersion('version-1');

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain('/points/delete');
    const body = JSON.parse(String(init?.body)) as {
      filter: { must: Array<Record<string, unknown>> };
    };
    expect(body.filter.must).toEqual([{ key: 'version_id', match: { value: 'version-1' } }]);
  });

  it('treats a missing collection as nothing-to-delete, not a failure', async () => {
    // Otherwise the very first ingest on a fresh deployment fails, because the
    // pre-upsert delete runs before the collection has been created.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 404 }));
    const store = new QdrantVectorStore(config());

    await expect(store.deleteVersion('version-1')).resolves.toBeUndefined();
    await expect(store.deleteDocument('document-1')).resolves.toBeUndefined();
  });
});

describe('upload contract', () => {
  it('excludes application/pdf from the default allowlist', () => {
    // PDF ingestion is not implemented. Allowing the upload would return 201
    // and then dead-letter the job after retries, so the user believes an
    // unindexed document is indexed. Rejecting at the boundary is honest.
    expect(config().rag.storage.allowedMimeTypes).not.toContain('application/pdf');
    expect(config().rag.storage.allowedMimeTypes).toEqual(
      expect.arrayContaining(['text/plain', 'text/markdown', 'text/html']),
    );
  });
});
