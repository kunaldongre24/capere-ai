import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { OrgRole } from '../shared/database';
import type { AuthenticatedUser } from './jwt-verifier.service';

/** Marks a route as reachable without authentication. */
export const PUBLIC_KEY = 'capere:public';
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_KEY, true);

/** Roles permitted to invoke a handler. Enforced by RolesGuard. */
export const ROLES_KEY = 'capere:roles';
export const Roles = (...roles: OrgRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);

/** Marks a route as authenticated by API key rather than user JWT. */
export const API_KEY_AUTH_KEY = 'capere:api_key_auth';
export const ApiKeyAuth = (): MethodDecorator & ClassDecorator =>
  SetMetadata(API_KEY_AUTH_KEY, true);

/**
 * Skips active-organization resolution for a route.
 *
 * Needed for endpoints that exist precisely because no organization is chosen
 * yet — "list my organizations", "accept an invite", the current-user profile.
 * Without this, OrganizationGuard would reject a user who belongs to zero or to
 * several organizations, making those endpoints unreachable.
 *
 * Authentication still applies; only tenant resolution is skipped.
 */
export const SKIP_ORGANIZATION_KEY = 'capere:skip_organization';
export const SkipOrganization = (): MethodDecorator & ClassDecorator =>
  SetMetadata(SKIP_ORGANIZATION_KEY, true);

/**
 * Request augmented by the auth guards.
 *
 * Populated only after verification — a handler reading these can trust them.
 */
export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
  organizationId?: string;
  /**
   * The caller's primary role. For a JWT user this is their single membership
   * role; for an API key it is the first of `organizationRoles`.
   */
  organizationRole?: OrgRole;
  /**
   * Every role the caller holds. An API key may grant several, so RolesGuard
   * must check against this array — collapsing it to a scalar would deny
   * requests the key is genuinely authorized for.
   */
  organizationRoles?: OrgRole[];
  apiKeyId?: string;
}

/**
 * Injects the verified user.
 *
 *   findAll(@CurrentUser() user: AuthenticatedUser)
 */
export const CurrentUser = createParamDecorator(
  (data: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;
    if (!user) return undefined;
    return data ? user[data] : user;
  },
);

/**
 * Injects the active organization id, resolved and membership-checked by
 * OrganizationGuard.
 *
 *   findAll(@CurrentOrg() organizationId: string)
 */
export const CurrentOrg = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  return request.organizationId;
});

/** Injects the caller's role within the active organization. */
export const CurrentOrgRole = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  return request.organizationRole;
});
