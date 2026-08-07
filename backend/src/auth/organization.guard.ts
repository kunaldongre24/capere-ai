import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { enrichContext } from '../shared/context';
import { AppException, ErrorCode } from '../shared/http';
import { PUBLIC_KEY, SKIP_ORGANIZATION_KEY, type AuthenticatedRequest } from './auth.decorators';
import { MembershipService } from './membership.service';

/**
 * Resolves the active organization and proves the caller belongs to it.
 *
 * This is the APPLICATION-LAYER half of tenant isolation. RLS is the database
 * half. Both exist on purpose: RLS alone cannot produce a good 403, and the app
 * layer alone is one forgotten `where` clause away from a cross-tenant leak.
 * Belt and braces, because the failure mode is a data breach.
 *
 * Resolution order for the active organization:
 *   1. `X-Organization-Id` header (explicit, how the UI switches orgs)
 *   2. `organizationId` route parameter
 *   3. The caller's sole membership, if they belong to exactly one org
 *
 * Requests authenticated by API key already carry a bound organization and
 * skip resolution entirely.
 */
@Injectable()
export class OrganizationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly membership: MembershipService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const skipOrganization = this.reflector.getAllAndOverride<boolean>(SKIP_ORGANIZATION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skipOrganization) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    // API-key callers are pre-bound to an organization by AuthGuard.
    if (request.apiKeyId && request.organizationId) {
      return true;
    }

    const user = request.user;
    if (!user) {
      throw AppException.unauthorized(
        ErrorCode.UNAUTHENTICATED,
        'Authentication is required to resolve an organization',
      );
    }

    const requested = this.requestedOrganizationId(request);

    if (requested) {
      const role = await this.membership.roleFor(user.id, requested);
      if (!role) {
        // Deliberately 403 with a generic message, not 404: distinguishing
        // "does not exist" from "you are not a member" would let a caller
        // enumerate which organization ids are real.
        throw AppException.forbidden(
          ErrorCode.NOT_ORGANIZATION_MEMBER,
          'You do not have access to this organization',
        );
      }

      request.organizationId = requested;
      request.organizationRole = role;
      enrichContext({ organizationId: requested });
      return true;
    }

    // No explicit organization: fall back only when it is unambiguous.
    const memberships = await this.membership.listFor(user.id);

    if (memberships.length === 0) {
      throw AppException.forbidden(
        ErrorCode.NOT_ORGANIZATION_MEMBER,
        'Your account does not belong to any organization',
      );
    }

    if (memberships.length > 1) {
      throw AppException.badRequest(
        ErrorCode.ORGANIZATION_REQUIRED,
        'You belong to multiple organizations — specify one with the X-Organization-Id header',
        { organizations: memberships.map((m) => m.organizationId) },
      );
    }

    const only = memberships[0];
    request.organizationId = only.organizationId;
    request.organizationRole = only.role;
    enrichContext({ organizationId: only.organizationId });
    return true;
  }

  private requestedOrganizationId(request: AuthenticatedRequest): string | undefined {
    const header = request.headers['x-organization-id'];
    if (typeof header === 'string' && header.length > 0) return header;

    const param = (request.params as Record<string, string> | undefined)?.organizationId;
    return param && param.length > 0 ? param : undefined;
  }
}
