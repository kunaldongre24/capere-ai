import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { OrgRole } from '../shared/database';
import { AppException, ErrorCode } from '../shared/http';
import { PUBLIC_KEY, ROLES_KEY, type AuthenticatedRequest } from './auth.decorators';

/**
 * Enforces `@Roles(...)` against the caller's role in the active organization.
 *
 * Runs after OrganizationGuard, which is what puts `organizationRole` on the
 * request. A handler with no `@Roles()` is open to any member.
 *
 * `capere_admin` is intentionally NOT a global superuser here: it is a role
 * held within a specific organization, so internal staff still need an explicit
 * membership row. That keeps the audit trail honest about who could see what.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<OrgRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    // A caller may hold several roles (API keys can grant more than one), so
    // check the full set. Falling back to the scalar covers JWT users, who have
    // exactly one role per organization.
    const granted: OrgRole[] =
      request.organizationRoles && request.organizationRoles.length > 0
        ? request.organizationRoles
        : request.organizationRole
          ? [request.organizationRole]
          : [];

    if (granted.length === 0) {
      // An API key with an empty roles array lands here. Report it as a role
      // problem rather than a missing organization, which is what the caller
      // can actually act on.
      throw AppException.forbidden(
        request.apiKeyId ? ErrorCode.INSUFFICIENT_ROLE : ErrorCode.ORGANIZATION_REQUIRED,
        request.apiKeyId
          ? 'This API key grants no roles and cannot perform any role-gated action.'
          : 'No organization role resolved for this request',
      );
    }

    const permitted = required.some((role) => granted.includes(role));

    if (!permitted) {
      throw AppException.forbidden(
        ErrorCode.INSUFFICIENT_ROLE,
        `This action requires one of: ${required.join(', ')}`,
        { requiredRoles: required, actualRoles: granted },
      );
    }

    return true;
  }
}
