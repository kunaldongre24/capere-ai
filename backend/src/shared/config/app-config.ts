import { envSchema, type Env } from './env.schema';

/**
 * Structured, immutable application configuration.
 *
 * Grouped by concern rather than exposing a flat bag of env vars, so consumers
 * depend on the slice they need (`config.database`) instead of the whole
 * environment. Nothing outside this module reads `process.env`.
 */
export interface AppConfig {
  readonly env: Env['NODE_ENV'];
  readonly isProduction: boolean;
  readonly isTest: boolean;
  readonly port: number;
  readonly logLevel: Env['LOG_LEVEL'];
  readonly corsOrigins: readonly string[];
  readonly webUrl: string;
  readonly managedTaskSecret: string;
  readonly identity: {
    readonly provider: 'supabase' | 'firebase';
    readonly firebaseProjectId: string;
  };
  readonly managedTasks: {
    readonly audience: string;
    readonly serviceAccount: string;
  };
  readonly jobs: {
    readonly dispatchMode: 'redis' | 'cloud_tasks';
    readonly googleCloudProject: string;
    readonly cloudTasksLocation: string;
    readonly cloudTasksQueue: string;
  };

  readonly database: {
    readonly url: string;
    readonly serviceRoleKey: string;
    readonly poolMax: number;
    readonly sslMode: 'verify' | 'disable';
    readonly sslCa?: string;
  };

  readonly supabase: {
    /** HS256 shared secret. Takes precedence over JWKS when both are present. */
    readonly jwtSecret: string;
    /** Project URL, used to derive the JWKS endpoint and default issuer. */
    readonly projectUrl: string;
    readonly audience: string;
    readonly issuer: string;
    readonly mode: 'hs256' | 'jwks' | 'unconfigured';
  };

  readonly auth: {
    readonly apiKeyHashingSalt: string;
  };

  readonly redis: {
    readonly url: string;
  };

  readonly ghl: {
    readonly baseUrl: string;
    readonly webhookSecret: string;
    readonly webhookPublicKey?: string;
    readonly webhookEd25519PublicKey?: string;
    readonly clientId: string;
    readonly clientSecret: string;
    /** Marketplace SSO shared secret used only for custom-menu user context. */
    readonly ssoKey: string;
    readonly redirectUri: string;
    readonly authorizationUrl: string;
    readonly tokenUrl: string;
    readonly scopes: readonly string[];
  };
  readonly google: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly redirectUri: string;
    readonly authorizationUrl: string;
    readonly tokenUrl: string;
    readonly placesApiKey: string;
    readonly scopes: readonly string[];
  };
  readonly dataForSeo: {
    readonly login: string;
    readonly password: string;
    readonly baseUrl: string;
    readonly pingbackUrl: string;
  };
  readonly github: {
    readonly appId: string;
    readonly privateKey: string;
    readonly webhookSecret: string;
    readonly apiUrl: string;
  };

  readonly openRouter: {
    /** Empty selects the deterministic fake provider — no network required. */
    readonly apiKey: string;
    readonly baseUrl: string;
    readonly timeoutMs: number;
    readonly enabled: boolean;
    readonly models: {
      readonly general: readonly string[];
      readonly analytics: readonly string[];
      readonly cheap: readonly string[];
    };
  };

  readonly encryption: {
    readonly key: Buffer;
    readonly keyVersion: number;
    /** version -> key, for decrypting data written before a rotation. */
    readonly previousKeys: ReadonlyMap<number, Buffer>;
  };

  readonly qdrant: {
    readonly url: string;
    readonly apiKey: string;
    readonly collection: string;
    readonly timeoutMs: number;
  };

  readonly vectorStore: {
    readonly provider: 'pgvector' | 'qdrant';
  };

  readonly rag: {
    readonly embeddingModel: string;
    readonly embeddingDimensions: number;
    readonly embeddingBatchSize: number;
    readonly vectorWriteBatchSize: number;
    readonly chunkSize: number;
    readonly chunkOverlap: number;
    readonly maxChunksPerDocument: number;
    readonly searchLimit: number;
    readonly storage: {
      readonly provider: 'supabase' | 'gcs';
      readonly bucket: string;
      readonly maxBytes: number;
      readonly signedUrlSeconds: number;
      readonly allowedMimeTypes: readonly string[];
    };
  };
}

/**
 * Parses `KEY_ENCRYPTION_KEYS_PREVIOUS` ("1:<base64>,2:<base64>") into a version
 * -> key map. Retired keys stay readable so a rotation does not orphan data.
 */
function parsePreviousKeys(raw: string): ReadonlyMap<number, Buffer> {
  const keys = new Map<number, Buffer>();
  if (!raw.trim()) return keys;

  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const separator = trimmed.indexOf(':');
    if (separator === -1) {
      throw new Error(
        `KEY_ENCRYPTION_KEYS_PREVIOUS: malformed entry "${trimmed}" — expected "<version>:<base64key>"`,
      );
    }

    const version = Number(trimmed.slice(0, separator));
    const key = Buffer.from(trimmed.slice(separator + 1), 'base64');

    if (!Number.isInteger(version) || version < 1) {
      throw new Error(
        `KEY_ENCRYPTION_KEYS_PREVIOUS: invalid version "${trimmed.slice(0, separator)}"`,
      );
    }
    if (key.length !== 32) {
      throw new Error(
        `KEY_ENCRYPTION_KEYS_PREVIOUS: key for version ${version} is not a 32-byte base64 value`,
      );
    }
    keys.set(version, key);
  }

  return keys;
}

/**
 * Formats a ZodError into an operator-readable failure. A config error should
 * tell you exactly which variable is wrong and why, on one line each.
 */
function formatValidationError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'issues' in error) {
    const issues = (error as { issues: Array<{ path: (string | number)[]; message: string }> })
      .issues;
    const lines = issues.map((issue) => {
      const name = issue.path.join('.') || '(root)';
      return `  - ${name}: ${issue.message}`;
    });
    return `Invalid environment configuration:\n${lines.join('\n')}`;
  }
  return `Invalid environment configuration: ${String(error)}`;
}

/**
 * Validates the given environment and builds the typed config.
 *
 * Throws with a readable, multi-line message listing every problem at once —
 * fixing config should not be a game of one-error-at-a-time whack-a-mole.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    throw new Error(formatValidationError(parsed.error));
  }

  const env = parsed.data;

  const supabaseMode: AppConfig['supabase']['mode'] = env.SUPABASE_JWT_SECRET
    ? 'hs256'
    : env.SUPABASE_PROJECT_URL
      ? 'jwks'
      : 'unconfigured';

  // Default the expected issuer from the project URL when not set explicitly.
  // Supabase issues tokens with iss = "<project-url>/auth/v1".
  const issuer =
    env.SUPABASE_ISSUER ||
    (env.SUPABASE_PROJECT_URL ? `${env.SUPABASE_PROJECT_URL.replace(/\/$/, '')}/auth/v1` : '');

  return Object.freeze({
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    corsOrigins: Object.freeze(env.CORS_ORIGINS),
    webUrl: env.APP_WEB_URL.replace(/\/$/, ''),
    managedTaskSecret: env.MANAGED_TASK_SECRET,
    identity: Object.freeze({ provider: env.AUTH_PROVIDER, firebaseProjectId: env.FIREBASE_PROJECT_ID }),
    managedTasks: Object.freeze({
      audience: env.MANAGED_TASK_AUDIENCE,
      serviceAccount: env.MANAGED_TASK_SERVICE_ACCOUNT,
    }),
    jobs: Object.freeze({
      dispatchMode: env.JOB_DISPATCH_MODE,
      googleCloudProject: env.GOOGLE_CLOUD_PROJECT,
      cloudTasksLocation: env.CLOUD_TASKS_LOCATION,
      cloudTasksQueue: env.CLOUD_TASKS_QUEUE,
    }),

    database: Object.freeze({
      url: env.DATABASE_URL,
      serviceRoleKey: env.DATABASE_SERVICE_ROLE_KEY,
      poolMax: env.DATABASE_POOL_MAX,
      sslMode: env.DATABASE_SSL_MODE,
      sslCa: env.DATABASE_SSL_CA_BASE64
        ? Buffer.from(env.DATABASE_SSL_CA_BASE64, 'base64').toString('utf8')
        : undefined,
    }),

    supabase: Object.freeze({
      jwtSecret: env.SUPABASE_JWT_SECRET,
      projectUrl: env.SUPABASE_PROJECT_URL,
      audience: env.SUPABASE_AUDIENCE,
      issuer,
      mode: supabaseMode,
    }),

    auth: Object.freeze({
      apiKeyHashingSalt: env.API_KEYS_HASHING_SALT,
    }),

    redis: Object.freeze({
      url: env.REDIS_URL,
    }),

    ghl: Object.freeze({
      baseUrl: env.GHL_API_BASE_URL,
      webhookSecret: env.GHL_WEBHOOK_SECRET,
      webhookPublicKey: env.GHL_WEBHOOK_PUBLIC_KEY_BASE64
        ? Buffer.from(env.GHL_WEBHOOK_PUBLIC_KEY_BASE64, 'base64').toString('utf8')
        : undefined,
      webhookEd25519PublicKey: env.GHL_WEBHOOK_ED25519_PUBLIC_KEY_BASE64
        ? Buffer.from(env.GHL_WEBHOOK_ED25519_PUBLIC_KEY_BASE64, 'base64').toString('utf8')
        : undefined,
      clientId: env.GHL_CLIENT_ID,
      clientSecret: env.GHL_CLIENT_SECRET,
      ssoKey: env.GHL_SSO_KEY,
      redirectUri: env.GHL_OAUTH_REDIRECT_URI,
      authorizationUrl: env.GHL_AUTHORIZATION_URL,
      tokenUrl: env.GHL_TOKEN_URL,
      scopes: Object.freeze([
        'locations.readonly',
        'users.readonly',
        'contacts.readonly',
        'contacts.write',
        'opportunities.readonly',
        'conversations.readonly',
        'calendars.readonly',
        'calendars/events.readonly',
        'locations/tasks.readonly',
        'locations/tasks.write',
        'workflows.readonly',
        'locations/customFields.readonly',
        'locations/customValues.readonly',
        'locations/customValues.write',
        'locations/tags.readonly',
        'locations/tags.write',
        'reputation/review.readonly',
      ]),
    }),
    google: Object.freeze({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI,
      authorizationUrl: env.GOOGLE_AUTHORIZATION_URL,
      tokenUrl: env.GOOGLE_TOKEN_URL,
      placesApiKey: env.GOOGLE_PLACES_API_KEY,
      scopes: Object.freeze([
        'openid',
        'email',
        'https://www.googleapis.com/auth/analytics.readonly',
        'https://www.googleapis.com/auth/webmasters.readonly',
        'https://www.googleapis.com/auth/business.manage',
      ]),
    }),
    dataForSeo: Object.freeze({
      login: env.DATAFORSEO_LOGIN,
      password: env.DATAFORSEO_PASSWORD,
      baseUrl: env.DATAFORSEO_BASE_URL,
      pingbackUrl: env.DATAFORSEO_PINGBACK_URL,
    }),
    github: Object.freeze({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_PRIVATE_KEY_BASE64
        ? Buffer.from(env.GITHUB_PRIVATE_KEY_BASE64, 'base64').toString('utf8')
        : '',
      webhookSecret: env.GITHUB_WEBHOOK_SECRET,
      apiUrl: env.GITHUB_API_URL.replace(/\/$/, ''),
    }),

    openRouter: Object.freeze({
      apiKey: env.OPENROUTER_API_KEY,
      baseUrl: env.OPENROUTER_BASE_URL,
      timeoutMs: env.OPENROUTER_TIMEOUT_MS,
      enabled: env.OPENROUTER_API_KEY.length > 0,
      models: Object.freeze({
        general: Object.freeze(env.OPENROUTER_MODELS_GENERAL),
        analytics: Object.freeze(env.OPENROUTER_MODELS_ANALYTICS),
        cheap: Object.freeze(env.OPENROUTER_MODELS_CHEAP),
      }),
    }),

    encryption: Object.freeze({
      key: Buffer.from(env.KEY_ENCRYPTION_KEY, 'base64'),
      keyVersion: env.ENCRYPTION_KEY_VERSION,
      previousKeys: parsePreviousKeys(env.KEY_ENCRYPTION_KEYS_PREVIOUS),
    }),

    qdrant: Object.freeze({
      url: env.QDRANT_URL,
      apiKey: env.QDRANT_API_KEY,
      collection: env.QDRANT_COLLECTION,
      timeoutMs: env.QDRANT_TIMEOUT_MS,
    }),

    vectorStore: Object.freeze({
      provider: env.VECTOR_STORE_PROVIDER,
    }),

    rag: Object.freeze({
      embeddingModel: env.RAG_EMBEDDING_MODEL,
      embeddingDimensions: env.RAG_EMBEDDING_DIMENSIONS,
      embeddingBatchSize: env.RAG_EMBEDDING_BATCH_SIZE,
      vectorWriteBatchSize: env.RAG_VECTOR_WRITE_BATCH_SIZE,
      chunkSize: env.RAG_CHUNK_SIZE,
      chunkOverlap: env.RAG_CHUNK_OVERLAP,
      maxChunksPerDocument: env.RAG_MAX_CHUNKS_PER_DOCUMENT,
      searchLimit: env.RAG_SEARCH_LIMIT,
      storage: Object.freeze({
        provider: env.RAG_STORAGE_PROVIDER,
        bucket: env.RAG_STORAGE_BUCKET,
        maxBytes: env.RAG_STORAGE_MAX_BYTES,
        signedUrlSeconds: env.RAG_STORAGE_SIGNED_URL_SECONDS,
        allowedMimeTypes: Object.freeze(env.RAG_STORAGE_ALLOWED_MIME_TYPES),
      }),
    }),
  });
}
