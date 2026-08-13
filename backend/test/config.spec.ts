import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/shared/config/app-config';
import { envSchema } from '../src/shared/config/env.schema';

/**
 * Test environment: all required vars present, Supabase auth unconfigured
 * (allowed because NODE_ENV=test), fake provider selected.
 */
function testEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    DATABASE_URL:
      'postgresql://postgres.test-ref:test-password@test.pooler.supabase.com:6543/postgres',
    REDIS_URL: 'redis://localhost:6379',
    API_KEYS_HASHING_SALT: 'test-salt-0123456789abcdef',
    OPEN_WEBUI_API_KEY: 'test-openwebui-key',
    KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    QDRANT_URL: 'http://localhost:6333',
    ...overrides,
  };
}

function productionEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return testEnv({
    NODE_ENV: 'production',
    SUPABASE_JWT_SECRET: 'prod-secret',
    SUPABASE_PROJECT_URL: 'https://project.supabase.co',
    DATABASE_SERVICE_ROLE_KEY: 'service-role-key',
    DATABASE_SSL_CA_BASE64: Buffer.from('trusted-ca').toString('base64'),
    OPENROUTER_API_KEY: 'sk-or-production',
    ...overrides,
  });
}

describe('config', () => {
  it('builds a valid config from a complete environment', () => {
    const config = loadConfig(testEnv());
    expect(config.env).toBe('test');
    expect(config.isTest).toBe(true);
    expect(config.port).toBe(3001);
    expect(config.database.url).toContain('pooler.supabase.com');
    expect(config.supabase.mode).toBe('unconfigured');
    expect(config.openRouter.enabled).toBe(false);
    expect(config.encryption.key).toHaveLength(32);
  });

  it('fails fast with a readable message when a required var is missing', () => {
    const env = testEnv();
    delete env.DATABASE_URL;

    expect(() => loadConfig(env)).toThrow(/Invalid environment configuration/);
    expect(() => loadConfig(env)).toThrow(/DATABASE_URL/);
  });

  it('uses the managed Redis default when Redis is not configured', () => {
    const env = testEnv();
    delete env.REDIS_URL;
    expect(loadConfig(env).redis.url).toBe('redis://localhost:6379');
  });

  it('accepts the fully managed production modes without Supabase or Redis credentials', () => {
    const env = productionEnv({
      AUTH_PROVIDER: 'firebase',
      FIREBASE_PROJECT_ID: 'capere-ai-786a0',
      JOB_DISPATCH_MODE: 'cloud_tasks',
      GOOGLE_CLOUD_PROJECT: 'capere-ai-786a0',
      MANAGED_TASK_AUDIENCE: 'https://capere-backend.example.run.app',
      MANAGED_TASK_SERVICE_ACCOUNT: 'capere-tasks@capere-ai-786a0.iam.gserviceaccount.com',
      RAG_STORAGE_PROVIDER: 'gcs',
      RAG_STORAGE_BUCKET: 'capere-ai-786a0-rag-sources',
      DATABASE_SSL_MODE: 'disable',
      DATABASE_SSL_CA_BASE64: '',
      SUPABASE_JWT_SECRET: '',
      SUPABASE_PROJECT_URL: '',
      DATABASE_SERVICE_ROLE_KEY: '',
    });
    delete env.REDIS_URL;
    const config = loadConfig(env);
    expect(config.identity.provider).toBe('firebase');
    expect(config.jobs.dispatchMode).toBe('cloud_tasks');
    expect(config.rag.storage.provider).toBe('gcs');
  });

  it('rejects a malformed encryption key', () => {
    expect(() => loadConfig(testEnv({ KEY_ENCRYPTION_KEY: 'not-base64!' }))).toThrow(
      /KEY_ENCRYPTION_KEY/,
    );
  });

  it('selects hs256 mode when a JWT secret is present', () => {
    const config = loadConfig(testEnv({ SUPABASE_JWT_SECRET: 'test-secret' }));
    expect(config.supabase.mode).toBe('hs256');
    expect(config.supabase.issuer).toBe('');
  });

  it('derives the issuer from the project URL in jwks mode', () => {
    const config = loadConfig(testEnv({ SUPABASE_PROJECT_URL: 'https://abcdef.supabase.co' }));
    expect(config.supabase.mode).toBe('jwks');
    expect(config.supabase.issuer).toBe('https://abcdef.supabase.co/auth/v1');
  });

  it('enables the real OpenRouter provider when a key is present', () => {
    const config = loadConfig(testEnv({ OPENROUTER_API_KEY: 'sk-or-test' }));
    expect(config.openRouter.enabled).toBe(true);
  });

  it('requires one Supabase verification mode outside of test', () => {
    expect(() => loadConfig(testEnv({ NODE_ENV: 'development' }))).toThrow(/SUPABASE_JWT_SECRET/);
  });

  it('refuses placeholder secrets in production', () => {
    const env = productionEnv({
      API_KEYS_HASHING_SALT: 'replace-me',
    });
    expect(() => loadConfig(env)).toThrow(/API_KEYS_HASHING_SALT/);
  });

  it('refuses fake AI providers in production', () => {
    const env = productionEnv({ OPENROUTER_API_KEY: '' });

    expect(() => loadConfig(env)).toThrow(/OPENROUTER_API_KEY/);
    expect(() => loadConfig(env)).toThrow(/fake AI and embedding providers are not permitted/);
  });

  it('allows production startup when OpenRouter is configured', () => {
    const config = loadConfig(productionEnv());

    expect(config.isProduction).toBe(true);
    expect(config.openRouter.enabled).toBe(true);
  });

  it('requires production Supabase storage and verified database TLS configuration', () => {
    expect(() => loadConfig(productionEnv({ DATABASE_SERVICE_ROLE_KEY: '' }))).toThrow(
      /DATABASE_SERVICE_ROLE_KEY/,
    );
    expect(() => loadConfig(productionEnv({ SUPABASE_PROJECT_URL: '' }))).toThrow(
      /SUPABASE_PROJECT_URL/,
    );
    expect(() => loadConfig(productionEnv({ DATABASE_SSL_CA_BASE64: '' }))).toThrow(
      /DATABASE_SSL_CA_BASE64/,
    );
  });

  it('parses previous encryption keys for rotation', () => {
    const oldKey = Buffer.alloc(32, 2).toString('base64');
    const config = loadConfig(testEnv({ KEY_ENCRYPTION_KEYS_PREVIOUS: `1:${oldKey}` }));
    expect(config.encryption.previousKeys.get(1)?.toString('base64')).toBe(oldKey);
  });

  it('rejects malformed previous-key entries', () => {
    expect(() => loadConfig(testEnv({ KEY_ENCRYPTION_KEYS_PREVIOUS: 'not-a-key-entry' }))).toThrow(
      /KEY_ENCRYPTION_KEYS_PREVIOUS/,
    );
  });

  it('rejects chunk overlap that is not smaller than chunk size', () => {
    expect(() => loadConfig(testEnv({ RAG_CHUNK_SIZE: '500', RAG_CHUNK_OVERLAP: '500' }))).toThrow(
      /RAG_CHUNK_OVERLAP/,
    );
  });

  it('parses CORS origins and model chains into arrays', () => {
    const config = loadConfig(
      testEnv({
        CORS_ORIGINS: 'http://a.example, http://b.example',
        OPENROUTER_MODELS_GENERAL: 'anthropic/claude-3.5-sonnet, openai/gpt-4o',
      }),
    );
    expect(config.corsOrigins).toEqual(['http://a.example', 'http://b.example']);
    expect(config.openRouter.models.general).toEqual([
      'anthropic/claude-3.5-sonnet',
      'openai/gpt-4o',
    ]);
  });

  describe('envSchema cross-field rules', () => {
    it('allows unconfigured Supabase in test', () => {
      const result = envSchema.safeParse(testEnv());
      expect(result.success).toBe(true);
    });
  });
});
