import { Injectable, SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedRequest } from '../auth';
import { AppException, ErrorCode } from '../shared/http';
import type { FeatureFlagKey } from './feature-flag.catalog';
import { FeatureFlagService } from './feature-flag.service';

export const FEATURE_FLAG_KEY = 'capere:feature_flag';

/**
 * Gates a route behind a feature flag.
 *
 *   @RequiresFeature(FeatureFlag.HermesPlanner)
 *   @Post('plan')
 *   createPlan() { ... }
 *
 * Returns 403 FEATURE_DISABLED rather than 404, because the route genuinely
 * exists and the caller's organization simply is not enrolled — a 404 would
 * send a client debugging a nonexistent routing problem.
 */
export const RequiresFeature = (flag: FeatureFlagKey): MethodDecorator & ClassDecorator =>
  SetMetadata(FEATURE_FLAG_KEY, flag);

@Injectable()
export class FeatureFlagGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly flags: FeatureFlagService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const flag = this.reflector.getAllAndOverride<FeatureFlagKey>(FEATURE_FLAG_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!flag) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const organizationId = request.organizationId;

    if (!organizationId) {
      // A flag-gated route is inherently organization-scoped; without a resolved
      // organization there is nothing to evaluate the flag against.
      throw AppException.forbidden(
        ErrorCode.ORGANIZATION_REQUIRED,
        'This endpoint requires an organization context',
      );
    }

    const enabled = await this.flags.isEnabled(organizationId, flag);
    if (!enabled) {
      throw AppException.forbidden(
        ErrorCode.FEATURE_DISABLED,
        'This feature is not enabled for your organization',
        { feature: flag },
      );
    }

    return true;
  }
}
