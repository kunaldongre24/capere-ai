-- Supabase pgvector-backed semantic store. Qdrant remains an optional adapter,
-- but pgvector is the default while Capere is operating at early SaaS scale.

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'vector' AND n.nspname = 'extensions'
  ) THEN
    RAISE EXCEPTION
      'The vector extension must be installed in schema "extensions" before applying pgvector migrations';
  END IF;
END $$;

CREATE TABLE capere.rag_vector_points (
  point_id uuid PRIMARY KEY REFERENCES capere.rag_chunks(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES capere.rag_documents(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES capere.rag_document_versions(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES capere.organizations(id) ON DELETE CASCADE,
  visibility capere.rag_visibility NOT NULL,
  embedding extensions.vector(1536) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rag_vector_points_visibility_owner CHECK (
    (visibility = 'shared' AND organization_id IS NULL)
    OR (visibility = 'tenant' AND organization_id IS NOT NULL)
  )
);

CREATE INDEX idx_rag_vector_points_tenant
  ON capere.rag_vector_points (visibility, organization_id);
CREATE INDEX idx_rag_vector_points_document
  ON capere.rag_vector_points (document_id);
CREATE INDEX idx_rag_vector_points_version
  ON capere.rag_vector_points (version_id);
CREATE INDEX idx_rag_vector_points_embedding_hnsw
  ON capere.rag_vector_points USING hnsw (embedding extensions.vector_cosine_ops);

CREATE OR REPLACE FUNCTION capere.enforce_rag_vector_point_integrity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = capere, extensions, pg_temp
AS $$
DECLARE
  expected_document_id uuid;
  expected_version_id uuid;
  expected_organization_id uuid;
  expected_visibility capere.rag_visibility;
BEGIN
  SELECT d.id, v.id, d.organization_id, d.visibility
    INTO expected_document_id, expected_version_id,
         expected_organization_id, expected_visibility
  FROM capere.rag_chunks c
  JOIN capere.rag_document_versions v ON v.id = c.version_id
  JOIN capere.rag_documents d ON d.id = v.document_id
  WHERE c.id = NEW.point_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RAG chunk % does not exist', NEW.point_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NEW.document_id IS DISTINCT FROM expected_document_id
    OR NEW.version_id IS DISTINCT FROM expected_version_id
    OR NEW.organization_id IS DISTINCT FROM expected_organization_id
    OR NEW.visibility IS DISTINCT FROM expected_visibility THEN
    RAISE EXCEPTION 'RAG vector ownership must match its source chunk and document'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER trg_rag_vector_points_integrity
  BEFORE INSERT OR UPDATE OF point_id, document_id, version_id, organization_id, visibility
  ON capere.rag_vector_points
  FOR EACH ROW EXECUTE FUNCTION capere.enforce_rag_vector_point_integrity();

CREATE TRIGGER trg_rag_vector_points_updated_at
  BEFORE UPDATE ON capere.rag_vector_points
  FOR EACH ROW EXECUTE FUNCTION capere.set_updated_at();

ALTER TABLE capere.rag_vector_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE capere.rag_vector_points FORCE ROW LEVEL SECURITY;

CREATE POLICY rag_vector_points_select ON capere.rag_vector_points
  FOR SELECT USING (
    visibility = 'shared'
    OR (visibility = 'tenant' AND capere.is_org_member(organization_id))
  );

COMMENT ON TABLE capere.rag_vector_points IS
  'Normalized pgvector search index. Text and citations remain canonical in rag_chunks/rag_documents.';
