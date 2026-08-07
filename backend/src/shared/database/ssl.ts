import type { ConnectionOptions } from 'node:tls';

/**
 * TLS options for the Postgres connection.
 *
 * Supabase requires an encrypted connection, but encryption alone is not
 * authentication: without a pinned CA the session is MITM-able, because
 * Supabase's pooler presents a certificate signed by its own CA which is not in
 * Node's trust store.
 *
 * So verification is driven by whether a CA was supplied:
 *
 *   - CA present  -> `rejectUnauthorized: true` and the cert is verified.
 *   - CA absent   -> encrypted but unverified. Acceptable for local development
 *                    only.
 *
 * `env.schema.ts` REQUIRES `DATABASE_SSL_CA_BASE64` when `NODE_ENV=production`,
 * so a production deployment cannot boot in the unverified state — the guard
 * lives at the config boundary rather than here, where a caller could forget it.
 */
export function resolveSsl(_connectionString: string, ca?: string): ConnectionOptions {
  return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: false };
}
