import { Global, Module } from '@nestjs/common';
import { loadConfig, type AppConfig } from './app-config';

/**
 * Injection token for the validated application config.
 *
 * Injected as `@Inject(APP_CONFIG) private readonly config: AppConfig`.
 */
export const APP_CONFIG = Symbol('APP_CONFIG');

/**
 * Global config module.
 *
 * `loadConfig` runs once at module construction, so a bad environment fails the
 * boot rather than the first request that happens to read the missing value.
 */
@Global()
@Module({
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: (): AppConfig => loadConfig(),
    },
  ],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
