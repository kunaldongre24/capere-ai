import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../shared/database';
import { AppException, ErrorCode } from '../shared/http';

export type ComponentStatus = 'up' | 'down';

export interface ReadinessReport {
  status: 'ok' | 'degraded';
  timestamp: string;
  components: Record<string, { status: ComponentStatus; latencyMs?: number; error?: string }>;
}

/**
 * A dependency the readiness probe checks.
 *
 * An interface rather than a hard-coded list so Redis, vector storage and OpenRouter
 * register themselves as those modules land, instead of this service growing a
 * dependency on every subsystem.
 */
export interface HealthIndicator {
  readonly name: string;
  check(): Promise<{ status: ComponentStatus; error?: string }>;
}

@Injectable()
export class HealthService {
  private readonly indicators: HealthIndicator[] = [];
  private readonly startedAt = Date.now();

  constructor(private readonly database: DatabaseService) {
    this.register({
      name: 'database',
      check: async () => {
        const ok = await this.database.ping();
        return ok ? { status: 'up' } : { status: 'down', error: 'ping failed' };
      },
    });
  }

  /** Registered by other modules at bootstrap. */
  register(indicator: HealthIndicator): void {
    this.indicators.push(indicator);
  }

  liveness(): { status: 'ok'; uptime: number; timestamp: string } {
    return {
      status: 'ok',
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Checks every dependency concurrently and returns 503 if any is down, so a
   * load balancer stops routing to this instance.
   */
  async readiness(): Promise<ReadinessReport> {
    const results = await Promise.all(
      this.indicators.map(async (indicator) => {
        const startedAt = Date.now();
        try {
          const result = await indicator.check();
          return {
            name: indicator.name,
            status: result.status,
            latencyMs: Date.now() - startedAt,
            error: result.error,
          };
        } catch (error) {
          return {
            name: indicator.name,
            status: 'down' as const,
            latencyMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );

    const components: ReadinessReport['components'] = {};
    for (const result of results) {
      components[result.name] = {
        status: result.status,
        latencyMs: result.latencyMs,
        ...(result.error ? { error: result.error } : {}),
      };
    }

    const healthy = results.every((r) => r.status === 'up');
    const report: ReadinessReport = {
      status: healthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      components,
    };

    if (!healthy) {
      // 503 is the signal orchestrators act on; the body explains which part.
      throw AppException.serviceUnavailable(
        ErrorCode.SERVICE_UNAVAILABLE,
        'One or more required dependencies are unavailable',
        report,
      );
    }

    return report;
  }
}
