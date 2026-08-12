import { Module } from '@nestjs/common';
import { AutomationModule } from '../automation';
import { InsightsModule } from '../insights';
import { RecommendationModule } from '../recommendations';
import { ReportingModule } from '../reporting';
import { IntegrationModule } from '../integrations/integration.module';
import { IntegrationJobWorker } from './integration-job.worker';
import { JobMonitoringController } from './job-monitoring.controller';
import { JobMonitoringService } from './job-monitoring.service';
import { OutboxRelayWorker } from './outbox-relay.worker';
import { QueueRegistryService } from './queue-registry.service';
import { SchedulerService } from './scheduler.service';
import { ManagedJobsController } from './managed-jobs.controller';
import { CloudTasksJobDispatcher, JOB_DISPATCHER, RedisJobDispatcher } from './job-dispatcher.service';
import { APP_CONFIG, type AppConfig } from '../shared/config';

/**
 * Jobs module.
 *
 * Provides the queue registry, outbox relay and scheduler, but does NOT start
 * them. `worker.ts` starts them; the API process does not.
 *
 * That split is deliberate: if the API also ran the relay, every API replica
 * would compete to process events, and a deploy that scaled the API to ten pods
 * would create ten relays. Keeping the loops in a dedicated worker process
 * makes their concurrency an explicit operational decision.
 *
 * InsightsModule is imported explicitly rather than made global: the insights
 * engine is a domain service with exactly two consumers (this module and the
 * intelligence context builder), and an explicit import documents that dependency
 * instead of hiding it behind ambient availability.
 */
@Module({
  imports: [
    AutomationModule,
    InsightsModule,
    IntegrationModule,
    RecommendationModule,
    ReportingModule,
  ],
  controllers: [JobMonitoringController, ManagedJobsController],
  providers: [
    QueueRegistryService,
    OutboxRelayWorker,
    SchedulerService,
    IntegrationJobWorker,
    RedisJobDispatcher,
    CloudTasksJobDispatcher,
    {
      provide: JOB_DISPATCHER,
      inject: [APP_CONFIG, RedisJobDispatcher, CloudTasksJobDispatcher],
      useFactory: (config: AppConfig, redis: RedisJobDispatcher, cloudTasks: CloudTasksJobDispatcher) =>
        config.jobs.dispatchMode === 'cloud_tasks' ? cloudTasks : redis,
    },
    JobMonitoringService,
  ],
  exports: [QueueRegistryService, OutboxRelayWorker, SchedulerService, IntegrationJobWorker, JOB_DISPATCHER],
})
export class JobsModule {}
