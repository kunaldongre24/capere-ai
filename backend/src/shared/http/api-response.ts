/**
 * Standardized API response envelope.
 *
 * Every endpoint returns the same outer shape, so clients (Open WebUI, Looker
 * Studio, the SEO Command Center UI) can handle success and failure uniformly
 * instead of special-casing each route.
 *
 *   success: { data, meta }
 *   failure: { error: { code, message, details? }, meta }
 *
 * `meta.requestId` is always present, which is what makes a user-reported
 * problem traceable to a specific log line.
 */

export interface ResponseMeta {
  requestId: string;
  timestamp: string;
  /** Present on paginated collection responses. */
  pagination?: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

export interface SuccessResponse<T> {
  data: T;
  meta: ResponseMeta;
}

export interface ErrorResponse {
  error: {
    /** Stable machine-readable code, e.g. 'ORGANIZATION_NOT_FOUND'. */
    code: string;
    message: string;
    /** Field-level validation problems, or other structured context. */
    details?: unknown;
  };
  meta: ResponseMeta;
}

export type ApiResponse<T> = SuccessResponse<T> | ErrorResponse;

/**
 * Application error codes.
 *
 * Centralized so they are never spelled as inline string literals — the
 * "no magic strings" rule. Clients branch on these, so they are part of the
 * public API contract and must not be renamed casually.
 */
export const ErrorCode = {
  // Auth / access
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_TOKEN: 'INVALID_TOKEN',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  INVALID_API_KEY: 'INVALID_API_KEY',
  FORBIDDEN: 'FORBIDDEN',
  INSUFFICIENT_ROLE: 'INSUFFICIENT_ROLE',
  NOT_ORGANIZATION_MEMBER: 'NOT_ORGANIZATION_MEMBER',
  ORGANIZATION_REQUIRED: 'ORGANIZATION_REQUIRED',

  // Validation
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  BAD_REQUEST: 'BAD_REQUEST',

  // Resources
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',

  // Feature gating
  FEATURE_DISABLED: 'FEATURE_DISABLED',

  // AI / budgets
  AI_BUDGET_EXCEEDED: 'AI_BUDGET_EXCEEDED',
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
  TOOL_EXECUTION_FAILED: 'TOOL_EXECUTION_FAILED',
  TOOL_TIMEOUT: 'TOOL_TIMEOUT',
  TOOL_NOT_FOUND: 'TOOL_NOT_FOUND',

  // Integrations
  INTEGRATION_NOT_CONNECTED: 'INTEGRATION_NOT_CONNECTED',
  INTEGRATION_ERROR: 'INTEGRATION_ERROR',
  CREDENTIAL_DECRYPTION_FAILED: 'CREDENTIAL_DECRYPTION_FAILED',

  // Infrastructure
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];
