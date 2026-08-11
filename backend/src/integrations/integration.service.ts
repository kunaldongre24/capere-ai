import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { CryptoService } from '../shared/crypto';
import { DatabaseService } from '../shared/database';
import { EventType, OutboxService } from '../shared/events';
import { AppException, ErrorCode } from '../shared/http';
import {
  GhlAdapter,
  GhlAdapterError,
  type GhlCredentials,
  type GhlTokenSet,
} from './ghl/ghl.adapter';
import type { ConnectGhlDto } from './integration.dto';

@Injectable()
export class IntegrationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly crypto: CryptoService,
    private readonly outbox: OutboxService,
    private readonly ghl: GhlAdapter,
  ) {}

  list(organizationId: string) {
    return this.database.db
      .selectFrom('capere.integrations as i')
      .leftJoin('capere.ghl_locations as l', 'l.id', 'i.ghl_location_id')
      .select([
        'i.id',
        'i.provider',
        'i.status',
        'i.account_id',
        'i.account_name',
        'i.scopes',
        'i.expires_at',
        'i.last_sync_at',
        'i.last_error',
        'i.created_at',
        'i.updated_at',
        'l.ghl_location_id',
        'l.name as location_name',
        'l.timezone',
      ])
      .where('i.organization_id', '=', organizationId)
      .orderBy('i.provider')
      .execute();
  }

  async connectGhl(organizationId: string, dto: ConnectGhlDto) {
    const credentials: GhlCredentials = { accessToken: dto.accessToken };
    return this.connectGhlCredentials(organizationId, dto.locationId, credentials, null);
  }

  async connectGhlOauth(organizationId: string, token: GhlTokenSet) {
    if (!token.locationId)
      throw AppException.badRequest(
        ErrorCode.INTEGRATION_ERROR,
        'GoHighLevel did not return an installed location',
      );
    const credentials: GhlCredentials = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? null,
      userType: token.userType,
    };
    return this.connectGhlCredentials(
      organizationId,
      token.locationId,
      credentials,
      new Date(Date.now() + token.expires_in * 1_000),
      {
        credentialType: 'oauth',
        companyId: token.companyId ?? null,
        userId: token.userId ?? null,
        userType: token.userType ?? null,
      },
    );
  }

  private async connectGhlCredentials(
    organizationId: string,
    locationId: string,
    credentials: GhlCredentials,
    expiresAt: Date | null,
    metadata: Record<string, unknown> = { credentialType: 'private_integration_token' },
  ) {
    let location;
    try {
      location = await this.ghl.getLocation(credentials, locationId);
    } catch (error) {
      if (error instanceof GhlAdapterError && error.kind === 'rate_limited') {
        throw AppException.tooManyRequests('GoHighLevel is rate limiting requests');
      }
      if (error instanceof GhlAdapterError && ['timeout', 'unavailable'].includes(error.kind)) {
        throw AppException.serviceUnavailable(
          ErrorCode.INTEGRATION_ERROR,
          'GoHighLevel is temporarily unavailable; retry shortly',
        );
      }
      throw AppException.badRequest(
        ErrorCode.INTEGRATION_ERROR,
        'GoHighLevel credentials or location could not be verified',
      );
    }

    return this.database.transaction(async (trx) => {
      // Serialize connection/reconnection for this organization/provider/location
      // before selecting the stable integration id used as encryption AAD.
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`go_high_level:${locationId}`}, 0))`.execute(
        trx,
      );

      // A GHL location is a tenant identifier and may belong to only one
      // Capere organization. Automatically retire an obsolete mapping when
      // its integration is no longer connected; never steal a live mapping.
      const occupied = await trx
        .selectFrom('capere.ghl_locations as l')
        .leftJoin('capere.integrations as i', (join) =>
          join
            .onRef('i.organization_id', '=', 'l.organization_id')
            .onRef('i.ghl_location_id', '=', 'l.id')
            .on('i.provider', '=', 'go_high_level'),
        )
        .select(['l.id', 'l.organization_id', 'i.status'])
        .where('l.ghl_location_id', '=', locationId)
        .where('l.organization_id', '<>', organizationId)
        .executeTakeFirst();
      if (occupied?.status === 'connected') {
        throw AppException.conflict(
          ErrorCode.CONFLICT,
          'This GoHighLevel sub-account is already connected to another organization',
        );
      }
      if (occupied) {
        await trx
          .deleteFrom('capere.ghl_locations')
          .where('id', '=', occupied.id)
          .where('organization_id', '=', occupied.organization_id)
          .execute();
      }

      const locationRow = await trx
        .insertInto('capere.ghl_locations')
        .values({
          organization_id: organizationId,
          ghl_location_id: location.id,
          name: location.name ?? null,
          timezone: location.timezone ?? null,
          is_primary: true,
        })
        .onConflict((conflict) =>
          conflict.columns(['organization_id', 'ghl_location_id']).doUpdateSet({
            name: location.name ?? null,
            timezone: location.timezone ?? null,
          }),
        )
        .returningAll()
        .executeTakeFirstOrThrow();

      const existing = await trx
        .selectFrom('capere.integrations')
        .select('id')
        .where('organization_id', '=', organizationId)
        .where('provider', '=', 'go_high_level')
        .where('ghl_location_id', '=', locationRow.id)
        .executeTakeFirst();
      const integrationId = existing?.id ?? randomUUID();
      const encrypted = this.crypto.encryptJson(credentials, `integration:${integrationId}`);
      const integration = await trx
        .insertInto('capere.integrations')
        .values({
          id: integrationId,
          organization_id: organizationId,
          ghl_location_id: locationRow.id,
          provider: 'go_high_level',
          account_id: location.id,
          account_name: location.name ?? null,
          status: 'connected',
          encrypted_credentials: encrypted,
          key_version: this.crypto.keyVersion,
          scopes: 'read_write',
          token_type: 'Bearer',
          expires_at: expiresAt,
          last_sync_at: null,
          last_error: null,
          provider_metadata: JSON.stringify(metadata),
        })
        .onConflict((conflict) =>
          conflict
            .columns(['organization_id', 'provider', 'ghl_location_id'])
            .where('provider', '=', 'go_high_level')
            .doUpdateSet({
              account_id: location.id,
              account_name: location.name ?? null,
              status: 'connected',
              encrypted_credentials: encrypted,
              key_version: this.crypto.keyVersion,
              last_error: null,
              scopes: 'read_write',
              token_type: 'Bearer',
              expires_at: expiresAt,
              provider_metadata: JSON.stringify(metadata),
            }),
        )
        .returning(['id', 'provider', 'status', 'account_id', 'account_name', 'ghl_location_id'])
        .executeTakeFirstOrThrow();
      await this.outbox.publishInTransaction(trx, {
        type: EventType.IntegrationConnected,
        organizationId,
        aggregateType: 'integration',
        aggregateId: integration.id,
        payload: {
          integrationId: integration.id,
          provider: integration.provider,
          accountName: integration.account_name ?? undefined,
          ghlLocationId: location.id,
        },
      });
      return integration;
    });
  }

  async disconnect(organizationId: string, integrationId: string) {
    return this.database.transaction(async (trx) => {
      const integration = await trx
        .updateTable('capere.integrations')
        .set({ status: 'revoked', encrypted_credentials: null, expires_at: null, last_error: null })
        .where('id', '=', integrationId)
        .where('organization_id', '=', organizationId)
        .returning(['id', 'provider'])
        .executeTakeFirst();
      if (!integration) throw AppException.notFound(ErrorCode.NOT_FOUND, 'Integration not found');
      await this.outbox.publishInTransaction(trx, {
        type: EventType.IntegrationDisconnected,
        organizationId,
        aggregateType: 'integration',
        aggregateId: integration.id,
        payload: {
          integrationId: integration.id,
          provider: integration.provider,
          reason: 'user_revoked',
        },
      });
      return { disconnected: true };
    });
  }
}
