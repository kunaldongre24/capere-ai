import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Transaction } from 'kysely';
import type { GoogleAdapter } from '../src/integrations/google/google.adapter';
import {
  GoogleSyncService,
  normalizeGa4PropertyName,
  resolveSyncDateRange,
} from '../src/integrations/google/google-sync.service';
import type { GoogleTokenService } from '../src/integrations/google/google-token.service';
import type { Database, DatabaseService } from '../src/shared/database';
import type { OutboxService } from '../src/shared/events';
import { cleanup, closeDb, seedTwoOrganizations, serviceDb } from './helpers/database';

describe('GA4 property identifiers', () => {
  it('keeps canonical Google property names unchanged', () => {
    expect(normalizeGa4PropertyName('properties/323364891')).toBe('properties/323364891');
  });

  it('normalizes numeric property ids', () => {
    expect(normalizeGa4PropertyName('323364891')).toBe('properties/323364891');
  });

  it('rejects arbitrary provider paths', () => {
    expect(() => normalizeGa4PropertyName('../accounts/other')).toThrow(
      'GA4 property identifier is invalid',
    );
  });
});

describe('Google sync date ranges', () => {
  it('defaults to exactly seven complete UTC days ending yesterday', () => {
    expect(resolveSyncDateRange(undefined, undefined, new Date('2026-08-05T23:59:59Z'))).toEqual({
      start: '2026-07-29',
      end: '2026-08-04',
    });
  });

  it('derives a seven-day window from an explicit end date', () => {
    expect(resolveSyncDateRange(undefined, '2026-02-10')).toEqual({
      start: '2026-02-04',
      end: '2026-02-10',
    });
  });

  it('rejects malformed, impossible, and reversed dates', () => {
    expect(() => resolveSyncDateRange('2026/01/01', '2026-01-07')).toThrow('YYYY-MM-DD');
    expect(() => resolveSyncDateRange('2026-02-30', '2026-03-01')).toThrow('date is invalid');
    expect(() => resolveSyncDateRange('2026-01-08', '2026-01-07')).toThrow(
      'must not be after',
    );
  });
});

describe('GA4 synchronization', () => {
  afterAll(closeDb);

  it('uses the canonical report request and persists metrics, coverage, and its event', async () => {
    const fixture = await seedTwoOrganizations();
    try {
      const authorization = await serviceDb()
        .insertInto('capere.integration_authorizations')
        .values({
          organization_id: fixture.orgAId,
          provider: 'google',
          external_account_id: fixture.orgAId,
          encrypted_credentials: Buffer.from('test'),
          key_version: 1,
          scopes: [],
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const integration = await serviceDb()
        .insertInto('capere.integrations')
        .values({
          organization_id: fixture.orgAId,
          provider: 'google_analytics_4',
          account_id: '323364891',
          account_name: 'GA4 test',
          authorization_id: authorization.id,
          status: 'connected',
          sync_enabled: true,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const postJson = vi.fn().mockResolvedValue({
        rows: [
          {
            dimensionValues: [{ value: '20260804' }],
            metricValues: [
              { value: '12' },
              { value: '9' },
              { value: '31' },
              { value: '2' },
              { value: '145.5' },
            ],
          },
        ],
      });
      const publishInTransaction = vi.fn().mockResolvedValue('event-id');
      const database = {
        db: serviceDb(),
        transaction: <T>(fn: (trx: Transaction<Database>) => Promise<T>) =>
          serviceDb().transaction().execute(fn),
      } as unknown as DatabaseService;
      const sync = new GoogleSyncService(
        database,
        { postJson } as unknown as GoogleAdapter,
        { accessToken: vi.fn().mockResolvedValue('access-token') } as unknown as GoogleTokenService,
        { publishInTransaction } as unknown as OutboxService,
      );

      await expect(
        sync.sync(fixture.orgAId, integration.id, '2026-07-29', '2026-08-04'),
      ).resolves.toEqual({ rows: 1 });

      expect(postJson).toHaveBeenCalledWith(
        'https://analyticsdata.googleapis.com/v1beta/properties/323364891:runReport',
        'access-token',
        expect.objectContaining({
          dateRanges: [{ startDate: '2026-07-29', endDate: '2026-08-04' }],
          dimensions: [{ name: 'date' }],
          metrics: [
            { name: 'sessions' },
            { name: 'activeUsers' },
            { name: 'eventCount' },
            { name: 'conversions' },
            { name: 'totalRevenue' },
          ],
        }),
      );
      const metric = await serviceDb()
        .selectFrom('capere.analytics_daily')
        .select(['metric_date', 'metrics'])
        .where('integration_id', '=', integration.id)
        .executeTakeFirstOrThrow();
      expect(new Date(metric.metric_date).toISOString().slice(0, 10)).toBe('2026-08-04');
      expect(metric.metrics).toMatchObject({
        sessions: 12,
        activeUsers: 9,
        eventCount: 31,
        conversions: 2,
        revenue: 145.5,
      });
      const state = await serviceDb()
        .selectFrom('capere.integration_sync_states')
        .select(['status', 'cursor', 'last_succeeded_at'])
        .where('integration_id', '=', integration.id)
        .executeTakeFirstOrThrow();
      expect(state.status).toBe('succeeded');
      expect(state.last_succeeded_at).not.toBeNull();
      expect(state.cursor).toMatchObject({
        periodStart: '2026-07-29',
        periodEnd: '2026-08-04',
        rowCount: 1,
        providerCompletedAt: expect.any(String),
      });
      expect(publishInTransaction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          type: 'ga4.synced',
          organizationId: fixture.orgAId,
          payload: expect.objectContaining({ sessions: 12, conversions: 2 }),
        }),
      );
    } finally {
      await cleanup(fixture);
    }
  });

  it('persists explicit zero-row coverage after a successful provider response', async () => {
    const fixture = await seedTwoOrganizations();
    try {
      const authorization = await serviceDb()
        .insertInto('capere.integration_authorizations')
        .values({
          organization_id: fixture.orgAId,
          provider: 'google',
          encrypted_credentials: Buffer.from('test'),
          key_version: 1,
          scopes: [],
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const integration = await serviceDb()
        .insertInto('capere.integrations')
        .values({
          organization_id: fixture.orgAId,
          provider: 'google_analytics_4',
          account_id: 'properties/123',
          authorization_id: authorization.id,
          status: 'connected',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const database = {
        db: serviceDb(),
        transaction: <T>(fn: (trx: Transaction<Database>) => Promise<T>) =>
          serviceDb().transaction().execute(fn),
      } as unknown as DatabaseService;
      const sync = new GoogleSyncService(
        database,
        { postJson: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as GoogleAdapter,
        { accessToken: vi.fn().mockResolvedValue('token') } as unknown as GoogleTokenService,
        { publishInTransaction: vi.fn().mockResolvedValue('event') } as unknown as OutboxService,
      );
      await sync.sync(fixture.orgAId, integration.id, '2026-07-29', '2026-08-04');
      const state = await serviceDb()
        .selectFrom('capere.integration_sync_states')
        .select('cursor')
        .where('integration_id', '=', integration.id)
        .executeTakeFirstOrThrow();
      expect(state.cursor).toMatchObject({
        periodStart: '2026-07-29',
        periodEnd: '2026-08-04',
        rowCount: 0,
        providerCompletedAt: expect.any(String),
      });
    } finally {
      await cleanup(fixture);
    }
  });
});
