import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { CryptoService } from '../../shared/crypto';
import { DatabaseService } from '../../shared/database';
import { AppException, ErrorCode } from '../../shared/http';
import { GhlAdapter, type GhlCredentials } from './ghl.adapter';

@Injectable()
export class GhlTokenService {
  constructor(
    private readonly database: DatabaseService,
    private readonly crypto: CryptoService,
    private readonly adapter: GhlAdapter,
  ) {}

  async credentials(organizationId: string, integrationId: string): Promise<GhlCredentials> {
    return this.database.transaction(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ghl-token:${integrationId}`}, 0))`.execute(
        trx,
      );
      const row = await trx
        .selectFrom('capere.integrations')
        .select(['id', 'encrypted_credentials', 'expires_at', 'provider'])
        .where('organization_id', '=', organizationId)
        .where('id', '=', integrationId)
        .executeTakeFirst();
      if (!row?.encrypted_credentials || row.provider !== 'go_high_level')
        throw AppException.notFound(ErrorCode.NOT_FOUND, 'GoHighLevel integration not found');
      const credentials = this.crypto.decryptJson<GhlCredentials>(
        row.encrypted_credentials,
        `integration:${row.id}`,
      );
      if (!row.expires_at || row.expires_at.getTime() > Date.now() + 5 * 60_000) return credentials;
      if (!credentials.refreshToken)
        throw AppException.badRequest(
          ErrorCode.INTEGRATION_ERROR,
          'GoHighLevel authorization has expired; reconnect the integration',
        );
      const refreshed = await this.adapter.refreshToken(
        credentials.refreshToken,
        credentials.userType,
      );
      const next: GhlCredentials = {
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token ?? credentials.refreshToken,
        userType: refreshed.userType ?? credentials.userType,
      };
      await trx
        .updateTable('capere.integrations')
        .set({
          encrypted_credentials: this.crypto.encryptJson(next, `integration:${row.id}`),
          key_version: this.crypto.keyVersion,
          expires_at: new Date(Date.now() + refreshed.expires_in * 1_000),
          status: 'connected',
          last_error: null,
        })
        .where('id', '=', row.id)
        .execute();
      return next;
    });
  }
}
