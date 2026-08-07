-- Phase 4: specialized stateless intelligence capabilities.
INSERT INTO capere.feature_flags (key, description, default_enabled)
VALUES
  ('agent.seo', 'SEO specialist capability.', true),
  ('agent.analytics', 'Analytics specialist capability.', true),
  ('agent.cmo', 'AI CMO capability.', true),
  ('agent.content', 'Content generation capability.', true)
ON CONFLICT (key) DO UPDATE SET
  description = EXCLUDED.description,
  default_enabled = EXCLUDED.default_enabled;

