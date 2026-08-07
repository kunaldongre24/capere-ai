import { Module } from '@nestjs/common';
import { IntegrationHealthGenerator } from './generators/integration-health.generator';
import { GrowthMetricsGenerator } from './generators/growth-metrics.generator';
import { INSIGHT_GENERATORS, type InsightGenerator } from './insight.interface';
import { InsightsEngine } from './insights.engine';

/**
 * Insights module.
 *
 * Generators are collected into the INSIGHT_GENERATORS array token, so a new
 * one is added by writing the class and appending it to the factory's inject
 * list — the engine itself never changes. Phase 3's GA4/GSC/GBP generators plug
 * in exactly here.
 */
@Module({
  providers: [
    IntegrationHealthGenerator,
    GrowthMetricsGenerator,
    {
      provide: INSIGHT_GENERATORS,
      inject: [IntegrationHealthGenerator, GrowthMetricsGenerator],
      useFactory: (...generators: InsightGenerator[]): InsightGenerator[] => generators,
    },
    InsightsEngine,
  ],
  exports: [InsightsEngine, INSIGHT_GENERATORS],
})
export class InsightsModule {}
