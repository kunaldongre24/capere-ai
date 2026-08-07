-- Phase 1 reliability hardening: reclaimable outbox claims and durable job retries.

ALTER TABLE capere.domain_events
  ADD COLUMN claimed_at timestamptz,
  ADD COLUMN claim_token uuid;

DROP INDEX IF EXISTS capere.idx_domain_events_pending;
CREATE INDEX idx_domain_events_claimable
  ON capere.domain_events (created_at)
  WHERE consumed_at IS NULL AND attempts < max_attempts;

ALTER TABLE capere.job_runs
  ADD COLUMN max_attempts integer NOT NULL DEFAULT 3,
  ADD COLUMN next_retry_at timestamptz,
  ADD COLUMN lease_until timestamptz,
  ADD COLUMN claimed_by uuid;

CREATE INDEX idx_job_runs_retryable
  ON capere.job_runs (next_retry_at)
  WHERE status IN ('scheduled', 'running', 'failed');
