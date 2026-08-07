import pino, { type Logger as PinoLogger } from 'pino';
import type { AppConfig } from '../config';
import { getContext } from '../context/request-context';

/**
 * Structured logging.
 *
 * Two non-negotiables encoded here:
 *
 * 1. **Correlation.** Every line carries `requestId`, and `organizationId` /
 *    `userId` once known, pulled from AsyncLocalStorage rather than passed by
 *    hand. Without this, debugging a multi-tenant system means guessing which
 *    lines belong to which request.
 *
 * 2. **Redaction.** Access tokens, API keys and Authorization headers must never
 *    reach a log sink. The redact list below is deny-by-path; anything
 *    credential-shaped that we might plausibly log is enumerated. Logs are
 *    frequently shipped to third parties, so a leaked token in a log is a
 *    leaked token.
 */

const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-ghl-signature"]',
  'res.headers["set-cookie"]',
  'password',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'apiKey',
  'api_key',
  'client_secret',
  'clientSecret',
  'encrypted_credentials',
  'encryptedCredentials',
  'key_hash',
  'keyHash',
  'jwtSecret',
  'KEY_ENCRYPTION_KEY',
  'OPENROUTER_API_KEY',
  'SUPABASE_JWT_SECRET',
  '*.accessToken',
  '*.refreshToken',
  '*.apiKey',
];

const SENSITIVE_QUERY_KEYS = new Set([
  'access_token',
  'client_secret',
  'code',
  'code_verifier',
  'id_token',
  'refresh_token',
  'state',
  'token',
]);

function sanitizeUrl(rawUrl: unknown): unknown {
  if (typeof rawUrl !== 'string') return rawUrl;
  const queryStart = rawUrl.indexOf('?');
  if (queryStart === -1) return rawUrl;

  const path = rawUrl.slice(0, queryStart);
  const query = new URLSearchParams(rawUrl.slice(queryStart + 1));
  for (const key of query.keys()) {
    if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) query.set(key, '[REDACTED]');
  }
  const sanitized = query.toString();
  return sanitized ? `${path}?${sanitized}` : path;
}

function sanitizeQuery(query: unknown): unknown {
  if (!query || typeof query !== 'object' || Array.isArray(query)) return query;
  return Object.fromEntries(
    Object.entries(query).map(([key, value]) => [
      key,
      SENSITIVE_QUERY_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : value,
    ]),
  );
}

/** Sanitizes the serialized pino-http request before it reaches any log sink. */
export function sanitizeHttpRequest(request: unknown): unknown {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return request;
  const record = request as Record<string, unknown>;
  return {
    ...record,
    ...(record.url !== undefined ? { url: sanitizeUrl(record.url) } : {}),
    ...(record.originalUrl !== undefined ? { originalUrl: sanitizeUrl(record.originalUrl) } : {}),
    ...(record.query !== undefined ? { query: sanitizeQuery(record.query) } : {}),
  };
}

export function createLogger(config: AppConfig): PinoLogger {
  return pino({
    level: config.logLevel,
    // In development a human-readable stream is worth the dependency; in
    // production we emit newline-delimited JSON for log aggregators.
    transport:
      config.env === 'development'
        ? {
            target: 'pino-pretty',
            options: { colorize: true, singleLine: false, translateTime: 'SYS:HH:MM:ss.l' },
          }
        : undefined,
    redact: {
      paths: REDACTED_PATHS,
      censor: '[REDACTED]',
    },
    base: {
      service: 'capere-backend',
      env: config.env,
    },
    // Attach request correlation to every line automatically.
    mixin() {
      const context = getContext();
      if (!context) return {};
      return {
        requestId: context.requestId,
        ...(context.organizationId ? { organizationId: context.organizationId } : {}),
        ...(context.userId ? { userId: context.userId } : {}),
        ...(context.traceId ? { traceId: context.traceId } : {}),
      };
    },
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  });
}

export type { PinoLogger };
