import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { enrichContext } from '../shared/context';
import { AppException, ErrorCode } from '../shared/http';
import { ApiKeyService } from './api-key.service';
import { API_KEY_AUTH_KEY, PUBLIC_KEY, type AuthenticatedRequest } from './auth.decorators';
import { JwtVerifierService } from './jwt-verifier.service';

/**
 * Authenticates the request.
 *
 * Two credential types, deliberately kept distinct:
 *
 *   - **Bearer JWT** — a human user via Supabase Auth. The default.
 *   - **API key** — a machine client (Open WebUI). Only accepted on handlers
 *     explicitly marked `@ApiKeyAuth()`, so a leaked key cannot be replayed
 *     against the whole API surface — only against endpoints designed for it.
 *
 * On success the verified identity is attached to the request AND merged into
 * the ambient request context so log lines carry it from here on.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtVerifier: JwtVerifierService,
    private readonly apiKeys: ApiKeyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const acceptsApiKey = this.reflector.getAllAndOverride<boolean>(API_KEY_AUTH_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (acceptsApiKey) {
      const key = this.extractApiKey(request);
      if (key) {
        const resolved = await this.apiKeys.verify(key);
        request.apiKeyId = resolved.apiKeyId;
        request.organizationId = resolved.organizationId;
        // Carry ALL granted roles: a key issued with several must satisfy a
        // @Roles() check naming any of them.
        request.organizationRoles = resolved.roles;
        request.organizationRole = resolved.roles[0];
        // Machine callers have no user identity; downstream code must handle
        // `user` being absent rather than assuming a person is present.
        enrichContext({
          apiKeyId: resolved.apiKeyId,
          organizationId: resolved.organizationId,
        });
        return true;
      }
      // No API key present — fall through and try a bearer token, so a human
      // can also call an API-key endpoint from the browser.
    }

    const token = this.extractBearerToken(request);
    if (!token) {
      throw AppException.unauthorized(ErrorCode.UNAUTHENTICATED, 'Missing Authorization header');
    }

    const user = await this.jwtVerifier.verify(token);
    request.user = user;
    enrichContext({ userId: user.id });

    return true;
  }

  private extractBearerToken(request: AuthenticatedRequest): string | undefined {
    const header = request.headers.authorization;
    if (!header) return undefined;

    const [scheme, value] = header.split(' ');
    if (!value || scheme.toLowerCase() !== 'bearer') return undefined;

    // An API key sent as a bearer token is not a JWT; let the API-key path
    // handle it rather than failing signature verification confusingly.
    return value.startsWith('cap_') ? undefined : value;
  }

  private extractApiKey(request: AuthenticatedRequest): string | undefined {
    const explicit = request.headers['x-api-key'];
    if (typeof explicit === 'string' && explicit.length > 0) return explicit;

    // Open WebUI sends its key as `Authorization: Bearer <key>` because it
    // speaks the OpenAI protocol, so accept that form too.
    const header = request.headers.authorization;
    if (!header) return undefined;
    const [scheme, value] = header.split(' ');
    if (!value || scheme.toLowerCase() !== 'bearer') return undefined;

    return value.startsWith('cap_') ? value : undefined;
  }
}
