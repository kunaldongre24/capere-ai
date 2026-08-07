import { Module } from '@nestjs/common';
import { ApiKeyService } from './api-key.service';
import { AuthGuard } from './auth.guard';
import { JwtVerifierService } from './jwt-verifier.service';
import { MembershipService } from './membership.service';
import { OrganizationGuard } from './organization.guard';
import { RolesGuard } from './roles.guard';

/**
 * Auth module.
 *
 * Guards are provided (not registered globally here) so the composition root in
 * `app.module.ts` decides the order they run in. Order matters:
 * AuthGuard -> OrganizationGuard -> RolesGuard, because each depends on what the
 * previous one resolved.
 */
@Module({
  providers: [
    JwtVerifierService,
    ApiKeyService,
    MembershipService,
    AuthGuard,
    OrganizationGuard,
    RolesGuard,
  ],
  exports: [
    JwtVerifierService,
    ApiKeyService,
    MembershipService,
    AuthGuard,
    OrganizationGuard,
    RolesGuard,
  ],
})
export class AuthModule {}
