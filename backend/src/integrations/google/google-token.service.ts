import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { CryptoService } from '../../shared/crypto';
import { DatabaseService } from '../../shared/database';
import { AppException, ErrorCode } from '../../shared/http';
import { GoogleAdapter } from './google.adapter';

interface StoredGoogleCredentials {
  accessToken: string;
  refreshToken: string | null;
}

@Injectable()
export class GoogleTokenService {
  constructor(
    private readonly database: DatabaseService,
    private readonly crypto: CryptoService,
    private readonly google: GoogleAdapter,
  ) {}

  async accessToken(organizationId: string, authorizationId: string): Promise<string> {
    return this.database.transaction(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`google-token:${authorizationId}`}, 0))`.execute(
        trx,
      );
      const row = await trx
        .selectFrom('capere.integration_authorizations')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', authorizationId)
        .where('provider', '=', 'google')
        .executeTakeFirst();
      if (!row) throw AppException.notFound(ErrorCode.NOT_FOUND, 'Google authorization not found');
      const credentials = this.crypto.decryptJson<StoredGoogleCredentials>(
        row.encrypted_credentials,
        `authorization:${row.id}`,
      );
      if (!row.expires_at || row.expires_at.getTime() > Date.now() + 5 * 60_000)
        return credentials.accessToken;
      if (!credentials.refreshToken)
        throw AppException.badRequest(
          ErrorCode.INTEGRATION_ERROR,
          'Google refresh token is unavailable; reconnect Google',
        );
      const refreshed = await this.google.refresh(credentials.refreshToken);
      const next = {
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token ?? credentials.refreshToken,
      };
      await trx
        .updateTable('capere.integration_authorizations')
        .set({
          encrypted_credentials: this.crypto.encryptJson(next, `authorization:${row.id}`),
          key_version: this.crypto.keyVersion,
          expires_at: new Date(Date.now() + refreshed.expires_in * 1_000),
        })
        .where('id', '=', row.id)
        .execute();
      return next.accessToken;
    });
  }
}
