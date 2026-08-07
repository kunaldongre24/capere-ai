-- Stateless intelligence compatibility migration. Historical Hermes-labelled
-- records remain unchanged for auditability and rollback.
ALTER TYPE capere.agent_kind ADD VALUE IF NOT EXISTS 'general';
