import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { CryptoService } from '../../shared/crypto';
import { DatabaseService } from '../../shared/database';
import { AppException, ErrorCode } from '../../shared/http';
import { IntegrationService } from '../integration.service';
import { GhlAdapter, GhlAdapterError } from './ghl.adapter';

const OAUTH_TTL_MS = 10 * 60_000;

@Injectable()
export class GhlOauthService {
  constructor(
    private readonly database: DatabaseService,
    private readonly crypto: CryptoService,
    private readonly adapter: GhlAdapter,
    private readonly integrations: IntegrationService,
  ) {}

  async beginAuthorization(organizationId: string, userId?: string): Promise<string> {
    const state = randomBytes(32).toString('base64url');
    const id = randomUUID();
    await this.database.db
      .insertInto('capere.oauth_states')
      .values({
        id,
        organization_id: organizationId,
        provider: 'go_high_level',
        state_hash: createHash('sha256').update(state).digest('hex'),
        encrypted_code_verifier: this.crypto.encrypt(
          randomBytes(32).toString('base64url'),
          `oauth-state:${id}`,
        ),
        redirect_uri: this.adapter.redirectUri,
        requested_scopes: [...this.adapter.scopes],
        expires_at: new Date(Date.now() + OAUTH_TTL_MS),
        consumed_at: null,
        created_by: userId ?? null,
      })
      .execute();
    return this.adapter.authorizationUrl(state);
  }

  async completeAuthorization(state: string, code: string) {
    if (!state || !code)
      throw AppException.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'OAuth state and authorization code are required',
      );
    const hash = createHash('sha256').update(state).digest('hex');
    const oauthState = await this.database.transaction(async (trx) => {
      const row = await trx
        .selectFrom('capere.oauth_states')
        .selectAll()
        .where('provider', '=', 'go_high_level')
        .where('state_hash', '=', hash)
        .where('expires_at', '>', new Date())
        .where('consumed_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!row)
        throw AppException.badRequest(
          ErrorCode.VALIDATION_FAILED,
          'OAuth state is invalid or expired',
        );
      await trx
        .updateTable('capere.oauth_states')
        .set({ consumed_at: new Date() })
        .where('id', '=', row.id)
        .execute();
      return row;
    });
    try {
      const token = await this.adapter.exchangeCode(code);
      return await this.integrations.connectGhlOauth(oauthState.organization_id, token);
    } catch (error) {
      if (error instanceof GhlAdapterError && error.kind === 'rate_limited')
        throw AppException.tooManyRequests('GoHighLevel is rate limiting OAuth requests');
      if (error instanceof AppException) throw error;
      throw AppException.badRequest(
        ErrorCode.INTEGRATION_ERROR,
        'GoHighLevel authorization could not be completed',
      );
    }
  }
}
