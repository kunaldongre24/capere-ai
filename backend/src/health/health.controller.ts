import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth';
import { RawResponse } from '../shared/http';
import { HealthService } from './health.service';

/**
 * Liveness and readiness.
 *
 * Deliberately distinct, because orchestrators use them for different things:
 *
 *   - `/health` (liveness) — "is the process alive?" Must not touch downstream
 *     dependencies. If it did, a transient database blip would make Kubernetes
 *     restart every healthy pod, turning a small outage into a total one.
 *
 *   - `/health/ready` (readiness) — "can this instance serve traffic?" Checks
 *     dependencies and returns 503 when they are down, so the pod is pulled
 *     from the load balancer without being killed.
 *
 * Both are `@Public()` (probes carry no credentials) and `@RawResponse()`
 * (probes expect a flat body, not the API envelope).
 */
@ApiTags('health')
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @Public()
  @RawResponse()
  @ApiOperation({ summary: 'Liveness probe — process is running' })
  liveness(): { status: 'ok'; uptime: number; timestamp: string } {
    return this.health.liveness();
  }

  @Get('ready')
  @Public()
  @RawResponse()
  @ApiOperation({ summary: 'Readiness probe — dependencies reachable' })
  async readiness(): Promise<unknown> {
    return this.health.readiness();
  }
}
