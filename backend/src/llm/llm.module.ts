import { Global, Logger, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../shared/config';
import { BudgetService } from './budgets/budget.service';
import { FakeLlmProvider } from './fake/fake-llm.provider';
import { LLM_PROVIDER, type LlmProvider } from './llm-provider.port';
import { OpenRouterProvider } from './openrouter/openrouter.provider';
import { ModelRouterService } from './router/model-router.service';
import { UsageService } from './usage/usage.service';

/**
 * LLM module.
 *
 * THE PROVIDER BINDING IS THE IMPORTANT PART: the concrete `LlmProvider` is
 * chosen once, here, from config. With no `OPENROUTER_API_KEY` the deterministic
 * fake is bound, so the entire Hermes loop runs offline with no spend. With a
 * key, the real adapter is bound. Nothing downstream knows or cares which — they
 * depend on the port.
 *
 * This is what makes "no credentials yet" a non-issue rather than a blocker, and
 * it is why the contract test suite runs against both implementations.
 */
@Global()
@Module({
  providers: [
    {
      provide: LLM_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): LlmProvider => {
        const logger = new Logger('LlmModule');

        if (config.openRouter.enabled) {
          logger.log('LLM provider: OpenRouter (live)');
          return new OpenRouterProvider(config);
        }

        // Config validation already rejects this state. Keep the invariant here
        // too, in case the module is ever supplied by a different config source.
        if (config.isProduction) {
          throw new Error(
            'OPENROUTER_API_KEY must be set in production; refusing to bind the fake LLM provider.',
          );
        }

        logger.warn('LLM provider: deterministic fake (no OPENROUTER_API_KEY set)');
        return new FakeLlmProvider();
      },
    },
    UsageService,
    BudgetService,
    ModelRouterService,
  ],
  exports: [LLM_PROVIDER, UsageService, BudgetService, ModelRouterService],
})
export class LlmModule {}
