import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthGuard, AuthModule, OrganizationGuard, RolesGuard } from './auth';
import { AutomationModule } from './automation';
import { ChatModule } from './chat';
import { FeatureFlagGuard, FeatureFlagsModule } from './feature-flags';
import { HealthModule } from './health';
import { InsightsModule } from './insights';
import { IntelligenceModule } from './intelligence';
import { IntegrationModule } from './integrations/integration.module';
import { JobsModule } from './jobs';
import { LlmModule } from './llm';
import { OrganizationModule } from './organizations/organization.module';
import { RagModule } from './rag/rag.module';
import { RecommendationModule } from './recommendations';
import { ReportingModule } from './reporting';
import { ConfigModule } from './shared/config';
import { RequestContextMiddleware } from './shared/context';
import { CryptoModule } from './shared/crypto';
import { DatabaseModule } from './shared/database';
import { EventsModule } from './shared/events';
import { LoggingModule } from './shared/logging';
import { GlobalExceptionFilter, ResponseInterceptor } from './shared/http';

/**
 * Composition root.
 *
 * GUARD ORDER IS SECURITY-CRITICAL and is the reason guards are registered here
 * rather than inside their own module. NestJS runs APP_GUARD providers in
 * declaration order:
 *
 *   1. ThrottlerGuard      — rate limit before doing any work, so an unauthenticated
 *                            flood cannot exhaust the database via auth lookups.
 *   2. AuthGuard           — establishes *who* is calling.
 *   3. OrganizationGuard   — establishes *which tenant*, and that they belong to it.
 *   4. RolesGuard          — establishes *whether they may* perform this action.
 *
 * Each step depends on what the previous one resolved. Reordering them silently
 * breaks tenant isolation, so the sequence is asserted by an e2e test.
 *
 * Everything is deny-by-default: a route is authenticated unless it opts out
 * with `@Public()`.
 */
@Module({
  imports: [
    // Global infrastructure. ConfigModule first — everything else reads config.
    ConfigModule,
    LoggingModule,
    DatabaseModule,
    CryptoModule,
    EventsModule,

    // Baseline rate limiting. Per-organization quotas layer on top later.
    ThrottlerModule.forRoot([
      { name: 'short', ttl: 1_000, limit: 20 },
      { name: 'medium', ttl: 60_000, limit: 300 },
    ]),

    AuthModule,
    AutomationModule,
    OrganizationModule,
    IntegrationModule,
    FeatureFlagsModule,
    LlmModule,
    RagModule,
    RecommendationModule,
    ReportingModule,
    IntelligenceModule,
    InsightsModule,
    ChatModule,
    JobsModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: OrganizationGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    // Last: only fires on routes carrying @RequiresFeature(), and needs the
    // organization that OrganizationGuard resolved.
    { provide: APP_GUARD, useClass: FeatureFlagGuard },

    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Runs before guards, so every log line — including auth failures — carries
    // a request id.
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
