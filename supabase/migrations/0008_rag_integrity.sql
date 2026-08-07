-- Phase 2 relational integrity hardening.
-- Ensures versions, active versions, and jobs cannot cross document boundaries,
-- and tenant job ownership always matches the referenced document.

ALTER TABLE capere.rag_document_versions
  ADD CONSTRAINT rag_versions_document_id_key UNIQUE (document_id, id);

ALTER TABLE capere.rag_documents
  DROP CONSTRAINT rag_documents_active_version_fk;

ALTER TABLE capere.rag_documents
  ADD CONSTRAINT rag_documents_active_version_fk
  FOREIGN KEY (id, active_version_id)
  REFERENCES capere.rag_document_versions (document_id, id)
  ON DELETE SET NULL (active_version_id);

ALTER TABLE capere.rag_ingestion_jobs
  DROP CONSTRAINT rag_ingestion_jobs_version_id_fkey;

ALTER TABLE capere.rag_ingestion_jobs
  ADD CONSTRAINT rag_jobs_document_version_fk
  FOREIGN KEY (document_id, version_id)
  REFERENCES capere.rag_document_versions (document_id, id)
  ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION capere.enforce_rag_job_organization()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = capere, pg_temp
AS $$
DECLARE
  document_org uuid;
BEGIN
  SELECT organization_id INTO document_org
  FROM capere.rag_documents
  WHERE id = NEW.document_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RAG document % does not exist', NEW.document_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NEW.organization_id IS DISTINCT FROM document_org THEN
    RAISE EXCEPTION 'RAG job organization must match its document organization'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER trg_rag_jobs_organization_integrity
  BEFORE INSERT OR UPDATE OF organization_id, document_id
  ON capere.rag_ingestion_jobs
  FOR EACH ROW EXECUTE FUNCTION capere.enforce_rag_job_organization();
