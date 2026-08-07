import { Global, Module } from '@nestjs/common';
import { InProcessEventBus } from './in-process-bus';
import { OutboxService } from './outbox.service';

/**
 * Event infrastructure.
 *
 * `InProcessEventBus` and `OutboxService` are provided globally. Subscribers
 * register themselves in their own modules' `onModuleInit`, which keeps the
 * bus decoupled from what listens to it — a Phase 3 module can subscribe to an
 * event without touching this module.
 */
@Global()
@Module({
  providers: [InProcessEventBus, OutboxService],
  exports: [InProcessEventBus, OutboxService],
})
export class EventsModule {}
