import { ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module';

/**
 * Health probe routing.
 *
 * WHY THIS TEST EXISTS: `/health` and `/health/ready` broke twice, silently, and
 * both times the failure was only caught by manual curl. They are the endpoints
 * a container orchestrator calls — a 404 on liveness means every pod is reported
 * unhealthy and restarted; a 404 on readiness means no pod is ever added to the
 * load balancer. The service would be undeployable while every other test
 * passed.
 *
 * The subtle part being locked down: `setGlobalPrefix({ exclude })` strips the
 * `api` prefix but does NOT opt a route out of URI versioning. With
 * `defaultVersion: '1'`, an excluded-but-versioned route resolves at
 * `/v1/health`, not `/health`. Only `version: VERSION_NEUTRAL` on the controller
 * produces the intended path — so this suite asserts the negative cases too.
 *
 * The bootstrap below mirrors `src/main.ts` for prefix and versioning
 * specifically. It deliberately does not reproduce helmet/CORS/Swagger, which
 * have no bearing on routing.
 */
describe('health probes (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();

    // Must match src/main.ts — this is the configuration under test.
    // BOTH opt-outs are required: `exclude` drops the /api prefix,
    // VERSION_NEUTRAL on the controller drops the version. Either alone gives
    // the wrong path (/v1/health or /api/health respectively).
    app.setGlobalPrefix('api', {
      exclude: ['health', 'health/ready', 'v1/chat/completions', 'v1/models'],
    });
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: '1',
    });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );

    await app.init();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  describe('liveness', () => {
    it('serves GET /health with an unversioned, unprefixed path', async () => {
      const response = await request(app.getHttpServer()).get('/health').expect(200);

      expect(response.body.status).toBe('ok');
      expect(typeof response.body.uptime).toBe('number');
      expect(typeof response.body.timestamp).toBe('string');
    });

    it('returns a flat body, not the { data, meta } envelope', async () => {
      // Probes expect a flat shape; @RawResponse() opts out of the envelope.
      const response = await request(app.getHttpServer()).get('/health').expect(200);

      expect(response.body).not.toHaveProperty('data');
      expect(response.body).not.toHaveProperty('meta');
    });

    it('requires no authentication', async () => {
      // Probes carry no credentials, so @Public() must apply.
      await request(app.getHttpServer()).get('/health').expect(200);
    });

    it('does NOT resolve at /v1/health', async () => {
      // Failure mode 1: VERSION_NEUTRAL missing, so versioning applies.
      await request(app.getHttpServer()).get('/v1/health').expect(404);
    });

    it('does NOT resolve at /api/health', async () => {
      // Failure mode 2: `exclude` entry missing, so the /api prefix applies.
      // Both this and the case above were produced during development by
      // fixing one mechanism and not the other.
      await request(app.getHttpServer()).get('/api/health').expect(404);
    });

    it('does NOT resolve at /api/v1/health', async () => {
      await request(app.getHttpServer()).get('/api/v1/health').expect(404);
    });
  });

  describe('readiness', () => {
    it('serves GET /health/ready and reports component status', async () => {
      const response = await request(app.getHttpServer()).get('/health/ready');

      // 200 when every dependency is reachable, 503 by design when one is not.
      // Both are correct behaviour; the routing is what this asserts.
      expect([200, 503]).toContain(response.status);

      const body =
        response.status === 200 ? response.body : (response.body.error?.details ?? response.body);
      expect(body).toHaveProperty('components');
      expect(body.components).toHaveProperty('database');
    }, 60_000);

    it('does NOT resolve at /v1/health/ready', async () => {
      await request(app.getHttpServer()).get('/v1/health/ready').expect(404);
    });
  });

  describe('prefix and versioning still apply elsewhere', () => {
    it('keeps the OpenAI-compatible chat route unprefixed', async () => {
      // Excluded from the `api` prefix AND VERSION_NEUTRAL, so it must exist at
      // /v1/models. Unauthenticated, so 401 — the point is that it is NOT 404.
      await request(app.getHttpServer()).get('/v1/models').expect(401);
    });

    it('does not expose the chat route under the api prefix', async () => {
      await request(app.getHttpServer()).get('/api/v1/models').expect(404);
    });
  });
});
