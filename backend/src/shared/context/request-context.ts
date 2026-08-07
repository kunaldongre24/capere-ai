import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Ambient per-request state.
 *
 * Carried through the async call graph with AsyncLocalStorage so that logging,
 * auditing and outbox writes can attach `requestId` / `organizationId` /
 * `userId` without every function signature growing three extra parameters.
 *
 * This is context for OBSERVABILITY and CONVENIENCE — never for authorization.
 * Guards resolve identity from the verified JWT and pass it explicitly; a
 * security decision must never read from ambient state, because a bug that
 * fails to populate it would silently widen access.
 */
export interface RequestContext {
  /** Correlation id echoed to the client and stamped on every log line. */
  readonly requestId: string;
  /** Supabase auth user id (JWT `sub`), when the request is authenticated. */
  readonly userId?: string;
  /** Active organization for this request. */
  readonly organizationId?: string;
  /** Distributed trace id, when an upstream provided one. */
  readonly traceId?: string;
  /** Set when the caller authenticated with an API key rather than a JWT. */
  readonly apiKeyId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Runs `fn` with the given context bound to the current async scope. */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The current context, or undefined outside a request (e.g. in a worker). */
export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

export function getOrganizationId(): string | undefined {
  return storage.getStore()?.organizationId;
}

export function getUserId(): string | undefined {
  return storage.getStore()?.userId;
}

/**
 * Merges additional fields into the current context for the remainder of the
 * async scope. Used by guards once identity is resolved.
 */
export function enrichContext(fields: Partial<RequestContext>): void {
  const current = storage.getStore();
  if (!current) return;
  // The stored object is intentionally mutated in place: AsyncLocalStorage has
  // no "replace the current store" operation, and guards need to add identity
  // to the context that logging already holds a reference to. The double cast
  // is required because RequestContext is readonly by design — callers must not
  // mutate it directly, only through this function.
  Object.assign(current as unknown as Record<string, unknown>, fields);
}
