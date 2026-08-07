import { Injectable } from '@nestjs/common';
import { CryptoService } from '../shared/crypto';
import { DatabaseService } from '../shared/database';
import { AppException, ErrorCode } from '../shared/http';

@Injectable()
export class CredentialVaultService {
  constructor(
    private readonly database: DatabaseService,
    private readonly crypto: CryptoService,
  ) {}

  async integrationCredentials<T>(organizationId: string, integrationId: string): Promise<T> {
    const row = await this.database.db
      .selectFrom('capere.integrations')
      .select(['id', 'encrypted_credentials'])
      .where('organization_id', '=', organizationId)
      .where('id', '=', integrationId)
      .executeTakeFirst();
    if (!row?.encrypted_credentials) {
      throw AppException.notFound(ErrorCode.NOT_FOUND, 'Integration credentials not found');
    }
    return this.crypto.decryptJson<T>(row.encrypted_credentials, `integration:${row.id}`);
  }
}
