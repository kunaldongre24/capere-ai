-- Phase 2 RAG metadata, source versions, chunks, and durable ingestion jobs.

CREATE TYPE capere.rag_visibility AS ENUM ('shared', 'tenant');
CREATE TYPE capere.rag_document_status AS ENUM ('pending', 'processing', 'indexed', 'failed', 'deleting', 'deleted');
CREATE TYPE capere.rag_version_status AS ENUM ('pending', 'processing', 'indexed', 'failed', 'superseded');
CREATE TYPE capere.rag_job_operation AS ENUM ('ingest', 'reindex', 'delete');
CREATE TYPE capere.rag_job_status AS ENUM ('queued', 'running', 'succeeded', 'failed', 'dead_lettered');

CREATE TABLE capere.rag_documents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid REFERENCES capere.organizations(id) ON DELETE CASCADE,
  visibility        capere.rag_visibility NOT NULL,
  title             text NOT NULL CHECK (length(trim(title)) > 0),
  description       text,
  source_filename   text NOT NULL CHECK (length(trim(source_filename)) > 0),
  source_mime_type  text NOT NULL,
  source_bytes      bigint NOT NULL CHECK (source_bytes > 0),
  storage_path      text NOT NULL UNIQUE,
  source_checksum   text NOT NULL CHECK (source_checksum ~ '^[0-9a-f]{64}$'),
  status            capere.rag_document_status NOT NULL DEFAULT 'pending',
  active_version_id uuid,
  created_by        uuid REFERENCES capere.users(id) ON DELETE SET NULL,
  updated_by        uuid REFERENCES capere.users(id) ON DELETE SET NULL,
  error_message     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rag_documents_visibility_owner CHECK (
    (visibility = 'shared' AND organization_id IS NULL)
    OR (visibility = 'tenant' AND organization_id IS NOT NULL)
  )
);

CREATE INDEX idx_rag_documents_org_status
  ON capere.rag_documents (organization_id, status);
CREATE INDEX idx_rag_documents_visibility_status
  ON capere.rag_documents (visibility, status);

CREATE TABLE capere.rag_document_versions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id          uuid NOT NULL REFERENCES capere.rag_documents(id) ON DELETE CASCADE,
  version_number       integer NOT NULL CHECK (version_number > 0),
  source_checksum      text NOT NULL CHECK (source_checksum ~ '^[0-9a-f]{64}$'),
  parser_fingerprint   text NOT NULL,
  chunker_fingerprint  text NOT NULL,
  embedding_fingerprint text NOT NULL,
  status               capere.rag_version_status NOT NULL DEFAULT 'pending',
  chunk_count          integer NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
  error_message        text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, version_number),
  UNIQUE (document_id, source_checksum)
);

ALTER TABLE capere.rag_documents
  ADD CONSTRAINT rag_documents_active_version_fk
  FOREIGN KEY (active_version_id) REFERENCES capere.rag_document_versions(id) ON DELETE SET NULL;

CREATE TABLE capere.rag_chunks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id     uuid NOT NULL REFERENCES capere.rag_document_versions(id) ON DELETE CASCADE,
  sequence       integer NOT NULL CHECK (sequence >= 0),
  content        text NOT NULL CHECK (length(trim(content)) > 0),
  content_checksum text NOT NULL CHECK (content_checksum ~ '^[0-9a-f]{64}$'),
  character_count integer NOT NULL CHECK (character_count > 0),
  token_count    integer,
  section        text,
  page_number    integer CHECK (page_number IS NULL OR page_number > 0),
  source_start   integer CHECK (source_start IS NULL OR source_start >= 0),
  source_end     integer CHECK (source_end IS NULL OR source_end >= source_start),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version_id, sequence),
  UNIQUE (version_id, content_checksum)
);

CREATE INDEX idx_rag_chunks_version ON capere.rag_chunks (version_id, sequence);

CREATE TABLE capere.rag_ingestion_jobs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES capere.organizations(id) ON DELETE CASCADE,
  document_id    uuid NOT NULL REFERENCES capere.rag_documents(id) ON DELETE CASCADE,
  version_id     uuid REFERENCES capere.rag_document_versions(id) ON DELETE CASCADE,
  operation      capere.rag_job_operation NOT NULL,
  status         capere.rag_job_status NOT NULL DEFAULT 'queued',
  idempotency_key text NOT NULL,
  attempts       integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts   integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  next_retry_at  timestamptz,
  lease_until    timestamptz,
  claimed_by     uuid,
  error_message  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operation, idempotency_key)
);

CREATE INDEX idx_rag_jobs_claimable
  ON capere.rag_ingestion_jobs (next_retry_at, created_at)
  WHERE status IN ('queued', 'failed');
CREATE INDEX idx_rag_jobs_document ON capere.rag_ingestion_jobs (document_id, created_at DESC);

CREATE TRIGGER trg_rag_documents_updated_at
  BEFORE UPDATE ON capere.rag_documents
  FOR EACH ROW EXECUTE FUNCTION capere.set_updated_at();
CREATE TRIGGER trg_rag_versions_updated_at
  BEFORE UPDATE ON capere.rag_document_versions
  FOR EACH ROW EXECUTE FUNCTION capere.set_updated_at();
CREATE TRIGGER trg_rag_jobs_updated_at
  BEFORE UPDATE ON capere.rag_ingestion_jobs
  FOR EACH ROW EXECUTE FUNCTION capere.set_updated_at();

ALTER TABLE capere.rag_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE capere.rag_document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE capere.rag_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE capere.rag_ingestion_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE capere.rag_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE capere.rag_document_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE capere.rag_chunks FORCE ROW LEVEL SECURITY;
ALTER TABLE capere.rag_ingestion_jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY rag_documents_select_permitted ON capere.rag_documents
  FOR SELECT TO authenticated
  USING (
    (visibility = 'shared' AND EXISTS (
      SELECT 1 FROM capere.organization_members m WHERE m.user_id = auth.uid()
    ))
    OR (visibility = 'tenant' AND capere.is_org_member(organization_id))
  );

CREATE POLICY rag_documents_insert_tenant_manager ON capere.rag_documents
  FOR INSERT TO authenticated
  WITH CHECK (
    visibility = 'tenant'
    AND capere.has_org_role(organization_id, ARRAY['owner', 'office_manager', 'marketing_manager']::capere.org_role[])
  );

CREATE POLICY rag_documents_insert_shared_admin ON capere.rag_documents
  FOR INSERT TO authenticated
  WITH CHECK (
    visibility = 'shared'
    AND EXISTS (
      SELECT 1 FROM capere.organization_members m
      WHERE m.user_id = auth.uid() AND m.role = 'capere_admin'
    )
  );

CREATE POLICY rag_documents_update_delete_permitted ON capere.rag_documents
  FOR ALL TO authenticated
  USING (
    (visibility = 'tenant' AND capere.has_org_role(organization_id, ARRAY['owner', 'office_manager', 'marketing_manager']::capere.org_role[]))
    OR (visibility = 'shared' AND EXISTS (
      SELECT 1 FROM capere.organization_members m
      WHERE m.user_id = auth.uid() AND m.role = 'capere_admin'
    ))
  )
  WITH CHECK (
    (visibility = 'tenant' AND capere.has_org_role(organization_id, ARRAY['owner', 'office_manager', 'marketing_manager']::capere.org_role[]))
    OR (visibility = 'shared' AND EXISTS (
      SELECT 1 FROM capere.organization_members m
      WHERE m.user_id = auth.uid() AND m.role = 'capere_admin'
    ))
  );

CREATE OR REPLACE FUNCTION capere.can_manage_rag_document(target_document uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = capere, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM capere.rag_documents d
    WHERE d.id = target_document
      AND (
        (d.visibility = 'tenant' AND capere.has_org_role(d.organization_id, ARRAY['owner', 'office_manager', 'marketing_manager']::capere.org_role[]))
        OR (d.visibility = 'shared' AND EXISTS (
          SELECT 1 FROM capere.organization_members m
          WHERE m.user_id = auth.uid() AND m.role = 'capere_admin'
        ))
      )
  )
$$;

CREATE POLICY rag_versions_select_permitted ON capere.rag_document_versions
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM capere.rag_documents d WHERE d.id = document_id));
CREATE POLICY rag_versions_write_permitted ON capere.rag_document_versions
  FOR ALL TO authenticated
  USING (capere.can_manage_rag_document(document_id))
  WITH CHECK (capere.can_manage_rag_document(document_id));

CREATE POLICY rag_chunks_select_permitted ON capere.rag_chunks
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM capere.rag_document_versions v
    JOIN capere.rag_documents d ON d.id = v.document_id
    WHERE v.id = version_id
  ));
CREATE POLICY rag_chunks_write_permitted ON capere.rag_chunks
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM capere.rag_document_versions v
    WHERE v.id = version_id AND capere.can_manage_rag_document(v.document_id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM capere.rag_document_versions v
    WHERE v.id = version_id AND capere.can_manage_rag_document(v.document_id)
  ));

CREATE POLICY rag_jobs_select_permitted ON capere.rag_ingestion_jobs
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM capere.rag_documents d WHERE d.id = document_id));
CREATE POLICY rag_jobs_write_permitted ON capere.rag_ingestion_jobs
  FOR ALL TO authenticated
  USING (capere.can_manage_rag_document(document_id))
  WITH CHECK (capere.can_manage_rag_document(document_id));
