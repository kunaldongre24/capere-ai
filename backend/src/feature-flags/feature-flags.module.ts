import { Global, Module } from '@nestjs/common';
import { FeatureFlagGuard } from './feature-flag.guard';
import { FeatureFlagService } from './feature-flag.service';

/**
 * Global so any module can inject FeatureFlagService without importing this
 * module explicitly — flags are consulted across intelligence, insights, chat and the
 * LLM layer, and threading an import through each would be noise.
 *
 * FeatureFlagGuard is provided but NOT registered as a global APP_GUARD: only
 * routes carrying @RequiresFeature() should pay for a flag lookup.
 */
@Global()
@Module({
  providers: [FeatureFlagService, FeatureFlagGuard],
  exports: [FeatureFlagService, FeatureFlagGuard],
})
export class FeatureFlagsModule {}
