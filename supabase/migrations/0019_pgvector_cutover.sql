-- Complete the Qdrant -> pgvector cutover safely for databases that already
-- contain documents marked indexed. Their canonical chunks remain in Postgres,
-- so workers can rebuild vectors without reading data from Qdrant.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'vector' AND n.nspname = 'extensions'
  ) THEN
    RAISE EXCEPTION 'The vector extension must be installed in schema "extensions"';
  END IF;
END $$;

DROP POLICY IF EXISTS rag_vector_points_select ON capere.rag_vector_points;
CREATE POLICY rag_vector_points_select ON capere.rag_vector_points
  FOR SELECT TO authenticated
  USING (
    (visibility = 'shared' AND EXISTS (
      SELECT 1
      FROM capere.organization_members m
      WHERE m.user_id = auth.uid()
    ))
    OR (visibility = 'tenant' AND capere.is_org_member(organization_id))
  );

WITH missing AS (
  SELECT d.id AS document_id, d.organization_id, d.active_version_id AS version_id
  FROM capere.rag_documents d
  WHERE d.status = 'indexed'
    AND d.active_version_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM capere.rag_vector_points p
      WHERE p.version_id = d.active_version_id
    )
)
UPDATE capere.rag_document_versions v
SET status = 'pending', error_message = NULL
FROM missing m
WHERE v.id = m.version_id;

WITH missing AS (
  SELECT d.id AS document_id, d.organization_id, d.active_version_id AS version_id
  FROM capere.rag_documents d
  WHERE d.status = 'indexed'
    AND d.active_version_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM capere.rag_vector_points p
      WHERE p.version_id = d.active_version_id
    )
)
INSERT INTO capere.rag_ingestion_jobs (
    organization_id, document_id, version_id, operation, status, idempotency_key
  )
  SELECT
    organization_id,
    document_id,
    version_id,
    'reindex',
    'queued',
    'pgvector-cutover-v1:' || version_id::text
  FROM missing
  ON CONFLICT (operation, idempotency_key) DO UPDATE SET
    status = 'queued',
    attempts = 0,
    next_retry_at = NULL,
    lease_until = NULL,
    claimed_by = NULL,
    error_message = NULL,
    updated_at = now();

UPDATE capere.rag_documents d
SET status = 'pending', error_message = NULL
WHERE d.status = 'indexed'
  AND d.active_version_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM capere.rag_vector_points p WHERE p.version_id = d.active_version_id
  );
