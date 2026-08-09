import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../shared/database';
import { EventType, type DomainEvent, type EventTypeValue } from '../../shared/events';
import type { InsightDraft, InsightGenerator } from '../insight.interface';

/**
 * Flags integrations that are disconnected, errored, or stale.
 *
 * WHY THIS ONE IS THE PHASE 1 GENERATOR: it is genuinely useful on day one and
 * depends on nothing outside Capere's own schema. A CPA firm whose GA4
 * connection silently expired stops receiving traffic reporting and usually
 * does not notice for weeks — meanwhile every AI answer about traffic is
 * answering from missing data. Surfacing it is real value, and it exercises the
 * entire pipe (generator → dedupe → outbox event → intelligence context) so Phase 3's
 * generators plug into a path already proven to work.
 *
 * Runs both reactively (on integration events) and on a schedule (to catch
 * staleness, which no event announces).
 */
@Injectable()
export class IntegrationHealthGenerator implements InsightGenerator {
  readonly name = 'integration_health';
  readonly description =
    'Flags integrations that are disconnected, in an error state, or have not synced recently.';

  readonly triggers: readonly EventTypeValue[] = [
    EventType.IntegrationDisconnected,
    EventType.IntegrationErrored,
  ];

  /** Beyond this, a "connected" integration is treated as stale. */
  private static readonly STALE_AFTER_HOURS = 48;

  constructor(private readonly database: DatabaseService) {}

  async generate(organizationId: string, _event?: DomainEvent): Promise<InsightDraft[]> {
    const integrations = await this.database.db
      .selectFrom('capere.integrations')
      .select(['id', 'provider', 'status', 'last_sync_at', 'last_error', 'expires_at'])
      .where('organization_id', '=', organizationId)
      .execute();

    const drafts: InsightDraft[] = [];
    const now = Date.now();

    for (const integration of integrations) {
      const label = this.label(integration.provider);

      if (integration.status === 'error') {
        drafts.push({
          category: 'operations',
          severity: 'high',
          title: `${label} is reporting an error`,
          body:
            `The ${label} connection is in an error state and is not returning data. ` +
            `Reporting that depends on it will be incomplete until it is reconnected.` +
            (integration.last_error ? ` Last error: ${integration.last_error}` : ''),
          dedupeKey: `integration_error:${integration.provider}`,
          payload: {
            integrationId: integration.id,
            provider: integration.provider,
            lastError: integration.last_error,
          },
        });
        continue;
      }

      if (integration.status === 'revoked' || integration.status === 'disconnected') {
        drafts.push({
          category: 'operations',
          severity: integration.status === 'revoked' ? 'high' : 'medium',
          title: `${label} is not connected`,
          body:
            `${label} is currently ${integration.status}. Any analysis or recommendation ` +
            `that would draw on this source is unavailable until it is reconnected.`,
          dedupeKey: `integration_disconnected:${integration.provider}`,
          payload: { integrationId: integration.id, provider: integration.provider },
        });
        continue;
      }

      if (integration.status !== 'connected') continue;

      // Connected but silent: the most dangerous state, because the UI says
      // everything is fine while the data quietly goes stale.
      if (integration.last_sync_at) {
        const hoursSinceSync = (now - integration.last_sync_at.getTime()) / 3_600_000;
        if (hoursSinceSync > IntegrationHealthGenerator.STALE_AFTER_HOURS) {
          drafts.push({
            category: 'operations',
            severity: 'medium',
            title: `${label} has not synced in ${Math.floor(hoursSinceSync / 24)} days`,
            body:
              `${label} reports as connected but has not returned new data since ` +
              `${integration.last_sync_at.toISOString().slice(0, 10)}. Figures from this ` +
              `source may be out of date.`,
            dedupeKey: `integration_stale:${integration.provider}`,
            payload: {
              integrationId: integration.id,
              provider: integration.provider,
              lastSyncAt: integration.last_sync_at.toISOString(),
              hoursSinceSync: Math.floor(hoursSinceSync),
            },
          });
        }
      }
    }

    return drafts;
  }

  private label(provider: string): string {
    const labels: Record<string, string> = {
      go_high_level: 'GoHighLevel',
      google_analytics_4: 'Google Analytics 4',
      google_search_console: 'Google Search Console',
      google_business_profile: 'Google Business Profile',
      data_for_seo: 'DataForSEO',
      github: 'GitHub',
    };
    return labels[provider] ?? provider;
  }
}
