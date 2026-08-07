import { Global, Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { APP_CONFIG } from '../config';
import { createLogger, sanitizeHttpRequest } from './logger.factory';

/**
 * Global logging module.
 *
 * Uses nestjs-pino's LoggerModule so every HTTP request is logged through the
 * same pino instance (and thus the same correlation mixin and redaction rules)
 * as everything else.
 */
@Global()
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: Parameters<typeof createLogger>[0]) => ({
        pinoHttp: {
          logger: createLogger(config),
          serializers: { req: sanitizeHttpRequest },
          // The response payload is irrelevant noise; status and latency matter.
          autoLogging: {
            ignore: (req) => req.url === '/health' || req.url === '/health/ready',
          },
        },
      }),
    }),
  ],
})
export class LoggingModule {}
