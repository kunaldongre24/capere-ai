-- The enum value was committed by migration 0011 before this transaction uses it.
ALTER TABLE capere.ai_sessions ALTER COLUMN agent SET DEFAULT 'general';
ALTER TABLE capere.ai_usage_events ALTER COLUMN agent SET DEFAULT 'general';

INSERT INTO capere.feature_flags (key, description, default_enabled)
VALUES
  ('intelligence.response_review', 'Review generated responses before returning them.', true),
  ('intelligence.bounded_tools', 'Allow capped read-only model-selected tool execution.', true)
ON CONFLICT (key) DO UPDATE SET
  description = EXCLUDED.description,
  default_enabled = EXCLUDED.default_enabled;

INSERT INTO capere.organization_feature_flags
  (organization_id, flag_id, enabled, changed_by, reason)
SELECT old_override.organization_id, new_flag.id, old_override.enabled,
       old_override.changed_by, 'Migrated from hermes.reflection'
FROM capere.organization_feature_flags old_override
JOIN capere.feature_flags old_flag ON old_flag.id = old_override.flag_id
CROSS JOIN capere.feature_flags new_flag
WHERE old_flag.key = 'hermes.reflection'
  AND new_flag.key = 'intelligence.response_review'
ON CONFLICT (organization_id, flag_id) DO NOTHING;

INSERT INTO capere.prompt_templates
  (name, version, content, checksum, description, is_active)
SELECT
  CASE name
    WHEN 'hermes.system' THEN 'intelligence.general.system'
    WHEN 'hermes.reflection' THEN 'intelligence.response_review'
    WHEN 'hermes.tool_failure' THEN 'intelligence.tool_failure'
  END,
  version, content, checksum,
  replace(coalesce(description, ''), 'Hermes', 'stateless intelligence'), is_active
FROM capere.prompt_templates
WHERE name IN ('hermes.system', 'hermes.reflection', 'hermes.tool_failure')
ON CONFLICT (name, version) DO NOTHING;

INSERT INTO capere.prompt_overrides
  (organization_id, name, content, checksum, reason, created_by)
SELECT organization_id,
  CASE name
    WHEN 'hermes.system' THEN 'intelligence.general.system'
    WHEN 'hermes.reflection' THEN 'intelligence.response_review'
    WHEN 'hermes.tool_failure' THEN 'intelligence.tool_failure'
  END,
  content, checksum, coalesce(reason, 'Migrated from Hermes prompt override'), created_by
FROM capere.prompt_overrides
WHERE name IN ('hermes.system', 'hermes.reflection', 'hermes.tool_failure')
ON CONFLICT (organization_id, name) DO NOTHING;
