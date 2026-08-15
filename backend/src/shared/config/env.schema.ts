import { z } from 'zod';

/**
 * Environment schema.
 *
 * This is the single source of truth for every environment variable the service
 * reads. Nothing outside this file may touch `process.env` — everything goes
 * through the typed `AppConfig` this produces.
 *
 * The service fails fast at boot if anything required is missing or malformed,
 * because a config error discovered at request time is a config error
 * discovered by a customer.
 */

const nodeEnv = z.enum(['development', 'test', 'production']);

/** Comma-separated string -> trimmed, non-empty string array. */
const csv = z
  .string()
  .transform((value) =>
    value
      .split(/[|,]/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  )
  .pipe(z.array(z.string()));

/** Base64-encoded 32-byte key, as produced by `openssl rand -base64 32`. */
const base64Key32 = z
  .string()
  .min(1, 'must be set')
  .refine(
    (value) => {
      try {
        return Buffer.from(value, 'base64').length === 32;
      } catch {
        return false;
      }
    },
    { message: 'must be a base64-encoded 32-byte key (generate: openssl rand -base64 32)' },
  );

const port = z.coerce.number().int().min(1).max(65_535);

export const envSchema = z
  .object({
    // --- General ---
    NODE_ENV: nodeEnv.default('development'),
    PORT: port.default(3001),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    CORS_ORIGINS: csv.default('http://localhost:8080'),
    APP_WEB_URL: z.string().url().default('https://app.capereai.com'),
    MARKETING_ORGANIZATION_ID: z.string().uuid().optional().or(z.literal('')).default(''),
    MARKETING_BOOKING_URL: z.string().url().optional().or(z.literal('')).default(''),
    MANAGED_TASK_SECRET: z.string().optional().default(''),
    AUTH_PROVIDER: z.enum(['supabase', 'firebase']).default('supabase'),
    FIREBASE_PROJECT_ID: z.string().optional().default(''),
    MANAGED_TASK_AUDIENCE: z.string().url().optional().or(z.literal('')).default(''),
    MANAGED_TASK_SERVICE_ACCOUNT: z.string().email().optional().or(z.literal('')).default(''),
    JOB_DISPATCH_MODE: z.enum(['redis', 'cloud_tasks']).default('redis'),
    GOOGLE_CLOUD_PROJECT: z.string().optional().default(''),
    CLOUD_TASKS_LOCATION: z.string().default('asia-south1'),
    CLOUD_TASKS_QUEUE: z.string().default('capere-integration-jobs'),

    // --- Database ---
    DATABASE_URL: z.string().url('must be a valid postgres connection string'),
    DATABASE_SERVICE_ROLE_KEY: z.string().optional().default(''),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    DATABASE_SSL_MODE: z.enum(['verify', 'disable']).default('verify'),
    DATABASE_SSL_CA_BASE64: z.string().optional().default(''),

    // --- Supabase Auth ---
    // Either SUPABASE_JWT_SECRET (HS256) or SUPABASE_PROJECT_URL (JWKS) must be
    // present outside of test. Cross-field rule enforced below.
    SUPABASE_JWT_SECRET: z.string().optional().default(''),
    SUPABASE_PROJECT_URL: z.string().url().optional().or(z.literal('')).default(''),
    SUPABASE_AUDIENCE: z.string().default('authenticated'),
    SUPABASE_ISSUER: z.string().optional().default(''),

    // --- API keys ---
    API_KEYS_HASHING_SALT: z.string().min(16, 'must be at least 16 characters'),

    // --- Redis / BullMQ ---
    REDIS_URL: z.string().url('must be a valid redis:// URL').default('redis://localhost:6379'),

    // --- GoHighLevel ---
    GHL_API_BASE_URL: z.string().url().default('https://services.leadconnectorhq.com'),
    GHL_WEBHOOK_SECRET: z.string().optional().default(''),
    GHL_WEBHOOK_PUBLIC_KEY_BASE64: z.string().optional().default(''),
    GHL_WEBHOOK_ED25519_PUBLIC_KEY_BASE64: z.string().optional().default(''),
    GHL_CLIENT_ID: z.string().optional().default(''),
    GHL_CLIENT_SECRET: z.string().optional().default(''),
    GHL_SSO_KEY: z.string().optional().default(''),
    GHL_OAUTH_REDIRECT_URI: z.string().url().optional().or(z.literal('')).default(''),
    GHL_AUTHORIZATION_URL: z
      .string()
      .url()
      .default('https://marketplace.gohighlevel.com/oauth/chooselocation'),
    GHL_TOKEN_URL: z.string().url().default('https://services.leadconnectorhq.com/oauth/token'),

    // --- Phase 3 providers ---
    GOOGLE_CLIENT_ID: z.string().optional().default(''),
    GOOGLE_CLIENT_SECRET: z.string().optional().default(''),
    GOOGLE_OAUTH_REDIRECT_URI: z.string().url().optional().or(z.literal('')).default(''),
    GOOGLE_AUTHORIZATION_URL: z
      .string()
      .url()
      .default('https://accounts.google.com/o/oauth2/v2/auth'),
    GOOGLE_TOKEN_URL: z.string().url().default('https://oauth2.googleapis.com/token'),
    GOOGLE_PLACES_API_KEY: z.string().optional().default(''),
    DATAFORSEO_LOGIN: z.string().optional().default(''),
    DATAFORSEO_PASSWORD: z.string().optional().default(''),
    DATAFORSEO_BASE_URL: z.string().url().default('https://api.dataforseo.com/v3'),
    DATAFORSEO_PINGBACK_URL: z.string().url().optional().or(z.literal('')).default(''),
    GITHUB_APP_ID: z.string().optional().default(''),
    GITHUB_PRIVATE_KEY_BASE64: z.string().optional().default(''),
    GITHUB_WEBHOOK_SECRET: z.string().optional().default(''),
    GITHUB_API_URL: z.string().url().default('https://api.github.com'),

    // --- OpenRouter ---
    // Empty selects deterministic fake providers in development and test.
    // Production requires a real key; enforced by the cross-field rule below.
    OPENROUTER_API_KEY: z.string().optional().default(''),
    OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
    OPENROUTER_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
    OPENROUTER_MODELS_GENERAL: csv.default(
      'nvidia/nemotron-3-ultra-550b-a55b:free,deepseek/deepseek-v4-flash,qwen/qwen3.8-max',
    ),
    OPENROUTER_MODELS_ANALYTICS: csv.default(
      'nvidia/nemotron-3-ultra-550b-a55b:free,deepseek/deepseek-v4-flash,qwen/qwen3.8-max',
    ),
    OPENROUTER_MODELS_CHEAP: csv.default(
      'nvidia/nemotron-3-ultra-550b-a55b:free,deepseek/deepseek-v4-flash',
    ),

    // --- Encryption ---
    KEY_ENCRYPTION_KEY: base64Key32,
    ENCRYPTION_KEY_VERSION: z.coerce.number().int().min(1).default(1),
    // Older key versions retained for decryption during rotation.
    // Format: "1:<base64key>,2:<base64key>"
    KEY_ENCRYPTION_KEYS_PREVIOUS: z.string().optional().default(''),

    // --- Vector store and RAG (Phase 2) ---
    VECTOR_STORE_PROVIDER: z.enum(['pgvector', 'qdrant']).default('pgvector'),
    QDRANT_URL: z.string().url().default('http://localhost:6333'),
    QDRANT_API_KEY: z.string().optional().default(''),
    QDRANT_COLLECTION: z.string().min(1).default('capere-rag'),
    QDRANT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
    RAG_EMBEDDING_MODEL: z.string().min(1).default('openai/text-embedding-3-small'),
    RAG_EMBEDDING_DIMENSIONS: z.coerce.number().int().min(1).max(16_384).default(1_536),
    RAG_EMBEDDING_BATCH_SIZE: z.coerce.number().int().min(1).max(256).default(32),
    RAG_VECTOR_WRITE_BATCH_SIZE: z.coerce.number().int().min(1).max(1_000).default(250),
    RAG_CHUNK_SIZE: z.coerce.number().int().min(128).max(16_384).default(1_200),
    RAG_CHUNK_OVERLAP: z.coerce.number().int().min(0).max(4_096).default(150),
    RAG_MAX_CHUNKS_PER_DOCUMENT: z.coerce.number().int().min(1).max(100_000).default(10_000),
    RAG_SEARCH_LIMIT: z.coerce.number().int().min(1).max(100).default(8),
    RAG_STORAGE_BUCKET: z.string().min(1).default('rag-sources'),
    RAG_STORAGE_PROVIDER: z.enum(['supabase', 'gcs']).default('supabase'),
    // Files are currently buffered by Multer. Keep a hard ceiling until direct
    // streaming to Supabase Storage replaces in-memory multipart handling.
    RAG_STORAGE_MAX_BYTES: z.coerce.number().int().min(1).max(50_000_000).default(25_000_000),
    RAG_STORAGE_SIGNED_URL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
    // `application/pdf` is deliberately EXCLUDED until extraction is
    // implemented. Allowing it here would return 201 on upload and then
    // dead-letter the ingestion job after retries — the user believes the
    // document is indexed while every answer silently omits it. Rejecting at
    // the request boundary is the honest contract. See RagService.validateFile.
    RAG_STORAGE_ALLOWED_MIME_TYPES: csv.default('text/plain,text/markdown,text/html'),
  })
  .superRefine((env, ctx) => {
    if (env.VECTOR_STORE_PROVIDER === 'pgvector' && env.RAG_EMBEDDING_DIMENSIONS !== 1_536) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RAG_EMBEDDING_DIMENSIONS'],
        message: 'must be 1536 when VECTOR_STORE_PROVIDER=pgvector',
      });
    }
    if (env.RAG_CHUNK_OVERLAP >= env.RAG_CHUNK_SIZE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RAG_CHUNK_OVERLAP'],
        message: 'must be smaller than RAG_CHUNK_SIZE',
      });
    }

    // Auth must be verifiable. In test we allow a locally-signed secret, but in
    // any other environment one of the two Supabase verification modes must be
    // configured — otherwise every request would fail at runtime.
    if (env.NODE_ENV !== 'test' && env.AUTH_PROVIDER === 'supabase' && !env.SUPABASE_JWT_SECRET && !env.SUPABASE_PROJECT_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SUPABASE_JWT_SECRET'],
        message:
          'Set SUPABASE_JWT_SECRET (HS256 mode) or SUPABASE_PROJECT_URL (JWKS mode) — ' +
          'without one, no JWT can be verified.',
      });
    }

    // Guard against shipping the .env.example placeholders to production.
    if (env.NODE_ENV === 'production') {
      if (env.AUTH_PROVIDER === 'supabase' && !env.DATABASE_SERVICE_ROLE_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['DATABASE_SERVICE_ROLE_KEY'],
          message: 'must be set in production for service-side database and storage operations',
        });
      }
      if (env.JOB_DISPATCH_MODE === 'cloud_tasks') {
        if (!env.GOOGLE_CLOUD_PROJECT) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['GOOGLE_CLOUD_PROJECT'], message: 'must be set when JOB_DISPATCH_MODE=cloud_tasks' });
        }
        if (!env.MANAGED_TASK_AUDIENCE) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['MANAGED_TASK_AUDIENCE'], message: 'must be set when JOB_DISPATCH_MODE=cloud_tasks' });
        }
        if (!env.MANAGED_TASK_SERVICE_ACCOUNT) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['MANAGED_TASK_SERVICE_ACCOUNT'], message: 'must be set when JOB_DISPATCH_MODE=cloud_tasks' });
        }
      }
      if (env.AUTH_PROVIDER === 'firebase' && !env.FIREBASE_PROJECT_ID) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['FIREBASE_PROJECT_ID'], message: 'must be set when AUTH_PROVIDER=firebase' });
      }
      if (env.DATABASE_SSL_MODE === 'verify' && !env.DATABASE_SSL_CA_BASE64) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['DATABASE_SSL_CA_BASE64'],
          message: 'must contain the trusted PostgreSQL CA certificate in production',
        });
      }
      if ((env.AUTH_PROVIDER === 'supabase' || env.RAG_STORAGE_PROVIDER === 'supabase') && !env.SUPABASE_PROJECT_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SUPABASE_PROJECT_URL'],
          message: 'must be set in production for Supabase Storage operations',
        });
      }
      if (!env.OPENROUTER_API_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['OPENROUTER_API_KEY'],
          message:
            'must be set in production; deterministic fake AI and embedding providers are not permitted',
        });
      }
      const placeholders: Array<[string, string]> = [
        ['API_KEYS_HASHING_SALT', env.API_KEYS_HASHING_SALT],
        ['KEY_ENCRYPTION_KEY', env.KEY_ENCRYPTION_KEY],
      ];
      for (const [name, value] of placeholders) {
        if (value === 'replace-me') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [name],
            message:
              'is still the placeholder value "replace-me" — refusing to start in production',
          });
        }
      }
    }

    const providerGroups: Array<[string, string[]]> = [
      ['Google', [env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_OAUTH_REDIRECT_URI]],
      ['DataForSEO', [env.DATAFORSEO_LOGIN, env.DATAFORSEO_PASSWORD]],
      ['GitHub', [env.GITHUB_APP_ID, env.GITHUB_PRIVATE_KEY_BASE64]],
    ];
    for (const [name, values] of providerGroups) {
      const present = values.filter(Boolean).length;
      if (present > 0 && present < values.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: `${name} configuration must be complete or entirely unset`,
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;
