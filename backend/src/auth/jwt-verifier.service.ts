import { Inject, Injectable, Logger } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { APP_CONFIG, type AppConfig } from '../shared/config';
import { AppException, ErrorCode } from '../shared/http';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';

/**
 * Verified identity extracted from a Supabase JWT.
 *
 * Note what is NOT here: organization or role. Those live in Capere's own
 * `organization_members` table, not in the token. Putting them in JWT claims
 * would mean a revoked membership stays valid until the token expires — so
 * membership is resolved per-request from the database instead.
 */
export interface AuthenticatedUser {
  /** Supabase auth user id — the JWT `sub` claim. */
  readonly id: string;
  readonly email?: string;
  /** Supabase's own role claim ('authenticated' / 'anon'), not a Capere role. */
  readonly supabaseRole?: string;
  readonly issuedAt?: number;
  readonly expiresAt?: number;
}

/**
 * Verifies Supabase-issued JWTs.
 *
 * Supabase projects sign tokens one of two ways, and both are supported because
 * which one you get depends on when the project was created and whether the
 * team has migrated to asymmetric keys:
 *
 *   - **HS256** with the project's shared JWT secret (the long-standing default)
 *   - **RS256/ES256** verified against the project's JWKS endpoint (newer,
 *     asymmetric, supports rotation without redeploying the backend)
 *
 * Precedence: if a shared secret is configured, it wins — an operator who sets
 * it explicitly means it. Otherwise JWKS is used, with jose caching and
 * rotating keys automatically.
 *
 * In test, a locally-signed HS256 secret produces tokens with exactly this
 * shape, which is what lets the whole auth surface be tested with no Supabase
 * project.
 */
@Injectable()
export class JwtVerifierService {
  private readonly logger = new Logger(JwtVerifierService.name);
  private readonly secretKey?: Uint8Array;
  private readonly jwks?: JWTVerifyGetKey;
  private readonly audience: string;
  private readonly issuer?: string;
  private readonly firebaseAuth?: Auth;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.audience = config.identity.provider === 'firebase'
      ? config.identity.firebaseProjectId
      : config.supabase.audience;
    this.issuer = config.identity.provider === 'firebase'
      ? `https://securetoken.google.com/${config.identity.firebaseProjectId}`
      : config.supabase.issuer || undefined;

    if (config.identity.provider === 'firebase') {
      if (!getApps().length) initializeApp({ credential: applicationDefault(), projectId: config.identity.firebaseProjectId });
      this.firebaseAuth = getAuth();
      this.logger.log(`JWT verification: Firebase (${config.identity.firebaseProjectId})`);
      return;
    }

    if (config.supabase.projectUrl) {
      const jwksUrl = new URL(
        `${config.supabase.projectUrl.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`,
      );
      this.jwks = createRemoteJWKSet(jwksUrl);
    }

    if (config.supabase.mode === 'hs256') {
      this.secretKey = new TextEncoder().encode(config.supabase.jwtSecret);
      this.logger.log(this.jwks ? 'JWT verification: HS256 with JWKS fallback' : 'JWT verification: HS256 (shared secret)');
    } else if (config.supabase.mode === 'jwks') {
      this.logger.log(`JWT verification: JWKS (${new URL(config.supabase.projectUrl).host})`);
    } else {
      // Only reachable in test — loadConfig rejects this elsewhere.
      this.logger.warn(
        'JWT verification is UNCONFIGURED. Every token will be rejected. (Expected only in tests.)',
      );
    }
  }

  /**
   * Verifies a raw bearer token and returns the authenticated identity.
   *
   * Throws AppException with a specific code for expired vs malformed tokens,
   * since a client can meaningfully act on the difference (refresh vs re-login).
   */
  async verify(token: string): Promise<AuthenticatedUser> {
    if (this.firebaseAuth) {
      try {
        const payload = await this.firebaseAuth.verifySessionCookie(token, true).catch(() => this.firebaseAuth!.verifyIdToken(token, true));
        return {
          id: payload.uid,
          email: payload.email,
          issuedAt: payload.iat,
          expiresAt: payload.exp,
        };
      } catch (error) {
        throw this.translateError(error);
      }
    }
    if (!this.secretKey && !this.jwks) {
      throw AppException.unauthorized(
        ErrorCode.INVALID_TOKEN,
        'Authentication is not configured on this server',
      );
    }

    try {
      let payload: JWTPayload;
      try {
        ({ payload } = this.secretKey
          ? await jwtVerify(token, this.secretKey, this.verifyOptions())
          : await jwtVerify(token, this.jwks as JWTVerifyGetKey, this.verifyOptions()));
      } catch (firstError) {
        // Supabase projects can migrate from HS256 to rotating asymmetric keys.
        // If a JWKS endpoint is configured, retry there before rejecting.
        if (!this.secretKey || !this.jwks) throw firstError;
        ({ payload } = await jwtVerify(token, this.jwks, this.verifyOptions()));
      }

      return this.toUser(payload);
    } catch (error) {
      throw this.translateError(error);
    }
  }

  private verifyOptions(): Parameters<typeof jwtVerify>[2] {
    return {
      audience: this.audience,
      ...(this.issuer ? { issuer: this.issuer } : {}),
      // Supabase tokens are short-lived; allow minimal clock drift only.
      clockTolerance: 5,
    };
  }

  private toUser(payload: JWTPayload): AuthenticatedUser {
    const sub = payload.sub;
    if (!sub || typeof sub !== 'string') {
      throw AppException.unauthorized(ErrorCode.INVALID_TOKEN, 'Token is missing a subject claim');
    }

    return {
      id: sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      supabaseRole: typeof payload.role === 'string' ? payload.role : undefined,
      issuedAt: payload.iat,
      expiresAt: payload.exp,
    };
  }

  private translateError(error: unknown): AppException {
    if (error instanceof AppException) return error;

    const code = (error as { code?: string })?.code;

    // jose error codes are stable and worth mapping precisely.
    if (code === 'ERR_JWT_EXPIRED') {
      return AppException.unauthorized(ErrorCode.TOKEN_EXPIRED, 'Token has expired');
    }
    if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
      return AppException.unauthorized(
        ErrorCode.INVALID_TOKEN,
        'Token claims failed validation (issuer or audience mismatch)',
      );
    }
    if (code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' || code === 'ERR_JWKS_NO_MATCHING_KEY') {
      return AppException.unauthorized(ErrorCode.INVALID_TOKEN, 'Token signature is invalid');
    }

    // Anything else: log server-side, stay vague to the client.
    this.logger.debug(
      `Token verification failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return AppException.unauthorized(ErrorCode.INVALID_TOKEN, 'Token could not be verified');
  }
}
