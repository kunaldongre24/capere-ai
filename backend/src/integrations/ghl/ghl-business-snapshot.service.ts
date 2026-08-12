import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../shared/database';
import { GhlAdapter, type GhlCredentials } from './ghl.adapter';
import { GhlReputationService } from './ghl-reputation.service';
import { GhlTokenService } from './ghl-token.service';

type Source<T> = T & { available: boolean; message?: string };

export type GhlBusinessSnapshot = {
  connected: boolean;
  locationName?: string | null;
  generatedAt: string;
  contacts: Source<{ total: number; addedLast7Days: number; addedLast30Days: number }>;
  conversations: Source<{ total: number; unread: number; activeLast7Days: number }>;
  appointments: Source<{ upcoming7Days: number; upcoming30Days: number; calendars: number }>;
  workflows: Source<{ total: number; published: number }>;
  team: Source<{ users: number }>;
  reputation: Source<{ reviewCount: number; averageRating: number; unanswered: number }>;
};

@Injectable()
export class GhlBusinessSnapshotService {
  constructor(
    private readonly database: DatabaseService,
    private readonly adapter: GhlAdapter,
    private readonly tokens: GhlTokenService,
    private readonly reputation: GhlReputationService,
  ) {}

  async summary(organizationId: string): Promise<GhlBusinessSnapshot> {
    const integration = await this.database.db
      .selectFrom('capere.integrations')
      .select(['id', 'account_id', 'account_name'])
      .where('organization_id', '=', organizationId)
      .where('provider', '=', 'go_high_level')
      .where('status', '=', 'connected')
      .orderBy('created_at', 'asc')
      .executeTakeFirst();
    const unavailable = <T extends object>(data: T, message: string): Source<T> => ({
      ...data,
      available: false,
      message,
    });
    if (!integration?.account_id)
      return {
        connected: false,
        generatedAt: new Date().toISOString(),
        contacts: unavailable({ total: 0, addedLast7Days: 0, addedLast30Days: 0 }, 'GoHighLevel is not connected.'),
        conversations: unavailable({ total: 0, unread: 0, activeLast7Days: 0 }, 'GoHighLevel is not connected.'),
        appointments: unavailable({ upcoming7Days: 0, upcoming30Days: 0, calendars: 0 }, 'GoHighLevel is not connected.'),
        workflows: unavailable({ total: 0, published: 0 }, 'GoHighLevel is not connected.'),
        team: unavailable({ users: 0 }, 'GoHighLevel is not connected.'),
        reputation: unavailable({ reviewCount: 0, averageRating: 0, unanswered: 0 }, 'GoHighLevel is not connected.'),
      };

    let credentials: GhlCredentials;
    try {
      credentials = await this.tokens.credentials(organizationId, integration.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'GoHighLevel authorization is unavailable.';
      return {
        connected: true,
        locationName: integration.account_name,
        generatedAt: new Date().toISOString(),
        contacts: unavailable({ total: 0, addedLast7Days: 0, addedLast30Days: 0 }, message),
        conversations: unavailable({ total: 0, unread: 0, activeLast7Days: 0 }, message),
        appointments: unavailable({ upcoming7Days: 0, upcoming30Days: 0, calendars: 0 }, message),
        workflows: unavailable({ total: 0, published: 0 }, message),
        team: unavailable({ users: 0 }, message),
        reputation: unavailable({ reviewCount: 0, averageRating: 0, unanswered: 0 }, message),
      };
    }

    const safe = async <T extends object>(fallback: T, request: () => Promise<T>): Promise<Source<T>> => {
      try {
        return { ...(await request()), available: true };
      } catch (error) {
        return unavailable(
          fallback,
          error instanceof Error && /401|403/.test(error.message)
            ? 'This data needs approval in the Capere Marketplace app permissions.'
            : 'This GoHighLevel data is temporarily unavailable.',
        );
      }
    };
    const locationId = integration.account_id;
    const now = Date.now();
    const sevenDaysAgo = now - 7 * 86_400_000;
    const thirtyDaysAgo = now - 30 * 86_400_000;
    const sevenDaysAhead = now + 7 * 86_400_000;
    const thirtyDaysAhead = now + 30 * 86_400_000;

    const [contacts, conversations, appointments, workflows, team, reputation] = await Promise.all([
      safe({ total: 0, addedLast7Days: 0, addedLast30Days: 0 }, async () => {
        const body = await this.adapter.getJson<{
          contacts?: Array<{ dateAdded?: string; createdAt?: string }>;
          meta?: { total?: number };
        }>(credentials, '/contacts/', { locationId, limit: 100 });
        const rows = body.contacts ?? [];
        const created = rows.map((row) => new Date(row.dateAdded ?? row.createdAt ?? 0).getTime());
        return {
          total: Number(body.meta?.total ?? rows.length),
          addedLast7Days: created.filter((date) => date >= sevenDaysAgo).length,
          addedLast30Days: created.filter((date) => date >= thirtyDaysAgo).length,
        };
      }),
      safe({ total: 0, unread: 0, activeLast7Days: 0 }, async () => {
        const body = await this.adapter.getJson<{
          conversations?: Array<{ unreadCount?: number; lastMessageDate?: string; dateUpdated?: string }>;
          total?: number;
          meta?: { total?: number };
        }>(credentials, '/conversations/search', { locationId, limit: 100 });
        const rows = body.conversations ?? [];
        return {
          total: Number(body.total ?? body.meta?.total ?? rows.length),
          unread: rows.filter((row) => Number(row.unreadCount ?? 0) > 0).length,
          activeLast7Days: rows.filter((row) => new Date(row.lastMessageDate ?? row.dateUpdated ?? 0).getTime() >= sevenDaysAgo).length,
        };
      }),
      safe({ upcoming7Days: 0, upcoming30Days: 0, calendars: 0 }, async () => {
        const calendarBody = await this.adapter.getJson<{ calendars?: Array<{ id?: string }> }>(
          credentials,
          '/calendars/',
          { locationId },
        );
        const eventsBody = await this.adapter.getJson<{ events?: Array<{ startTime?: string; start?: string }> }>(
          credentials,
          '/calendars/events',
          { locationId, startTime: now, endTime: thirtyDaysAhead },
        );
        const times = (eventsBody.events ?? []).map((event) => new Date(event.startTime ?? event.start ?? 0).getTime());
        return {
          calendars: (calendarBody.calendars ?? []).length,
          upcoming7Days: times.filter((time) => time >= now && time <= sevenDaysAhead).length,
          upcoming30Days: times.filter((time) => time >= now && time <= thirtyDaysAhead).length,
        };
      }),
      safe({ total: 0, published: 0 }, async () => {
        const body = await this.adapter.getJson<{ workflows?: Array<{ status?: string; published?: boolean }> }>(
          credentials,
          '/workflows/',
          { locationId },
        );
        const rows = body.workflows ?? [];
        return {
          total: rows.length,
          published: rows.filter((row) => row.published || String(row.status).toLowerCase() === 'published').length,
        };
      }),
      safe({ users: 0 }, async () => {
        const body = await this.adapter.getJson<{ users?: unknown[] }>(credentials, '/users/', { locationId });
        return { users: (body.users ?? []).length };
      }),
      safe({ reviewCount: 0, averageRating: 0, unanswered: 0 }, async () => {
        const result = await this.reputation.summary(organizationId);
        if (!result.connected) throw new Error(result.message);
        return {
          reviewCount: result.reviewCount,
          averageRating: result.averageRating,
          unanswered: result.unanswered,
        };
      }),
    ]);

    return {
      connected: true,
      locationName: integration.account_name,
      generatedAt: new Date().toISOString(),
      contacts,
      conversations,
      appointments,
      workflows,
      team,
      reputation,
    };
  }
}
