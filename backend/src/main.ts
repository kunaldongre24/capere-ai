import 'reflect-metadata';
import * as path from 'node:path';
import * as dotenv from 'dotenv';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { APP_CONFIG, type AppConfig } from './shared/config';

// Load .env before anything reads config. In a container the environment is
// usually injected directly, so a missing file is not an error — `override:
// false` also ensures real environment variables always win over the file.
dotenv.config({ path: path.resolve(__dirname, '../../.env'), override: false });

/**
 * HTTP entrypoint.
 *
 * Routes are served under `/api/v1` from the very first commit — retrofitting a
 * version prefix after clients exist is a breaking change, and this system will
 * have at least three independent consumers (Open WebUI, Looker Studio, the GHL
 * custom menus).
 *
 * The one exception is `/v1/chat/completions`, which is excluded from the
 * global prefix because its path is dictated by the OpenAI wire format that
 * Open WebUI speaks.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    // Buffer until the pino logger is attached, so boot-time logs are not lost
    // and are formatted consistently with everything else.
    bufferLogs: true,
    rawBody: true,
  });

  app.useLogger(app.get(Logger));

  const config = app.get<AppConfig>(APP_CONFIG);

  // `/api` + URI versioning => `/api/v1/...`.
  //
  // The health probes and the OpenAI-compatible chat routes need BOTH opt-outs,
  // and they do different things — this cost three debugging cycles, so it is
  // worth stating precisely:
  //
  //   * `exclude` here removes the `/api` PREFIX. On its own, a route listed
  //     here is still versioned, so it resolves at `/v1/health`.
  //   * `version: VERSION_NEUTRAL` on the controller removes the VERSION. On
  //     its own, the prefix still applies, so it resolves at `/api/health`.
  //
  // Only both together produce the documented `/health` and `/health/ready`.
  app.setGlobalPrefix('api', {
    exclude: ['health', 'health/ready', 'v1/chat/completions', 'v1/models'],
  });
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

  app.use(
    helmet({
      // Swagger UI needs inline styles/scripts; CSP is otherwise on.
      contentSecurityPolicy: config.isProduction ? undefined : false,
    }),
  );

  app.enableCors({
    origin: config.corsOrigins as string[],
    credentials: true,
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Api-Key',
      'X-Organization-Id',
      'X-Request-Id',
    ],
    exposedHeaders: ['X-Request-Id'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      // Strip properties with no DTO decorator: prevents mass-assignment.
      whitelist: true,
      // Reject rather than silently strip, so clients learn about typos.
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Lets Nest run onModuleDestroy hooks (draining the DB pool, closing queues).
  app.enableShutdownHooks();

  const openApi = new DocumentBuilder()
    .setTitle('Capere AI')
    .setDescription(
      'AI Growth Operating System for CPA firms. The intelligence layer over GoHighLevel: ' +
        'GHL owns the CRM; Capere owns stateless intelligence, SEO, analytics, insights and workflows.',
    )
    .setVersion('1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'supabase-jwt')
    .addApiKey({ type: 'apiKey', name: 'X-Api-Key', in: 'header' }, 'api-key')
    .build();

  SwaggerModule.setup('api/v1/docs', app, SwaggerModule.createDocument(app, openApi), {
    swaggerOptions: { persistAuthorization: true },
  });

  await app.listen(config.port, '0.0.0.0');

  const logger = app.get(Logger);
  logger.log(`Capere AI listening on :${config.port} (${config.env})`);
  logger.log(`API      http://localhost:${config.port}/api/v1`);
  logger.log(`Docs     http://localhost:${config.port}/api/v1/docs`);
  logger.log(`Health   http://localhost:${config.port}/health`);
  if (!config.openRouter.enabled) {
    logger.warn('OPENROUTER_API_KEY is unset — using the deterministic fake LLM provider.');
  }
}

bootstrap().catch((error: unknown) => {
  // Config validation failures land here. Print the message plainly rather than
  // a stack trace: the operator needs to know which variable is wrong.
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFailed to start Capere AI:\n${message}\n`);
  process.exit(1);
});
