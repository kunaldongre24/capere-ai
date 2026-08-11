import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { CryptoService } from '../../shared/crypto';
import { DatabaseService } from '../../shared/database';
import { EventType, OutboxService } from '../../shared/events';
import { AppException, ErrorCode } from '../../shared/http';
import { ProviderAdapterError } from '../provider-adapter';
import { GhlAdapter } from '../ghl/ghl.adapter';
import { GhlTokenService } from '../ghl/ghl-token.service';
import { GoogleAdapter, type GoogleTokenSet } from './google.adapter';
import { GoogleTokenService } from './google-token.service';
import type {
  ConnectGoogleResourceDto,
  GoogleDiscoveryResponseDto,
  GoogleDiscoveryWarningDto,
} from './google.dto';

const OAUTH_TTL_MS = 10 * 60_000;
const CMO_RETURN_SCOPE = 'capere:return:cmo';

type GoogleResourceProvider = 'ga4' | 'gsc' | 'gbp';

type AutoMatchTarget = {
  readonly names: readonly string[];
  readonly domain?: string;
};

export function normalizedBusinessName(value: string | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function normalizedDomain(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const candidate = value.startsWith('sc-domain:') ? value.slice(10) : value;
  try {
    const url = new URL(candidate.includes('://') ? candidate : `https://${candidate}`);
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

type DiscoveryResult<T> =
  | { readonly value: T; readonly warning?: never }
  | { readonly value?: never; readonly warning: GoogleDiscoveryWarningDto };

@Injectable()
export class GoogleService {
  constructor(
    private readonly database: DatabaseService,
    private readonly crypto: CryptoService,
    private readonly google: GoogleAdapter,
    private readonly outbox: OutboxService,
    private readonly tokens: GoogleTokenService,
    private readonly ghl: GhlAdapter,
    private readonly ghlTokens: GhlTokenService,
  ) {}

  async beginAuthorization(
    organizationId: string,
    userId: string | undefined,
    returnTo?: string,
  ): Promise<string> {
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + OAUTH_TTL_MS);
    await this.database.db
      .insertInto('capere.oauth_states')
      .values({
        id,
        organization_id: organizationId,
        provider: 'google',
        state_hash: createHash('sha256').update(state).digest('hex'),
        encrypted_code_verifier: this.crypto.encrypt(verifier, `oauth-state:${id}`),
        redirect_uri: this.google.redirectUri,
        requested_scopes: [
          'openid',
          'email',
          'https://www.googleapis.com/auth/analytics.readonly',
          'https://www.googleapis.com/auth/webmasters.readonly',
          'https://www.googleapis.com/auth/business.manage',
          ...(returnTo === 'cmo' ? [CMO_RETURN_SCOPE] : []),
        ],
        expires_at: expiresAt,
        consumed_at: null,
        created_by: userId ?? null,
      })
      .execute();
    return this.google.authorizationUrl({
      state,
      codeChallenge: challenge,
      redirectUri: this.google.redirectUri,
    });
  }

  async completeAuthorization(
    state: string,
    code: string,
  ) {
    const stateHash = createHash('sha256').update(state).digest('hex');
    const row = await this.database.transaction(async (trx) => {
      const found = await trx
        .selectFrom('capere.oauth_states')
        .selectAll()
        .where('state_hash', '=', stateHash)
        .where('provider', '=', 'google')
        .where('expires_at', '>', new Date())
        .where('consumed_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!found)
        throw AppException.badRequest(
          ErrorCode.VALIDATION_FAILED,
          'OAuth state is invalid or expired',
        );
      await trx
        .updateTable('capere.oauth_states')
        .set({ consumed_at: new Date() })
        .where('id', '=', found.id)
        .execute();
      return found;
    });
    const verifier = this.crypto.decrypt(row.encrypted_code_verifier, `oauth-state:${row.id}`);
    let token: GoogleTokenSet;
    try {
      token = await this.google.exchangeCode(code, verifier, row.redirect_uri);
    } catch {
      throw AppException.badRequest(
        ErrorCode.INTEGRATION_ERROR,
        'Google authorization could not be completed',
      );
    }
    if (!token.access_token)
      throw AppException.badRequest(ErrorCode.INTEGRATION_ERROR, 'Google returned no access token');
    const authorizationId = randomUUID();
    const credentials = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? null,
    };
    await this.database.db
      .insertInto('capere.integration_authorizations')
      .values({
        id: authorizationId,
        organization_id: row.organization_id,
        provider: 'google',
        external_account_id: null,
        external_account_name: null,
        encrypted_credentials: this.crypto.encryptJson(
          credentials,
          `authorization:${authorizationId}`,
        ),
        key_version: this.crypto.keyVersion,
        scopes: (token.scope?.split(' ') ?? row.requested_scopes).filter(
          (scope) => scope !== CMO_RETURN_SCOPE,
        ),
        expires_at: new Date(Date.now() + token.expires_in * 1_000),
        metadata: JSON.stringify({}),
      })
      .execute();
    const automatic = await this.autoConnectResources(row.organization_id, authorizationId);
    return {
      organizationId: row.organization_id,
      authorizationId,
      returnTo: row.requested_scopes.includes(CMO_RETURN_SCOPE) ? 'cmo' : 'integrations',
      ...automatic,
    };
  }

  async connectResource(
    organizationId: string,
    authorizationId: string,
    dto: ConnectGoogleResourceDto,
  ) {
    const authorization = await this.database.db
      .selectFrom('capere.integration_authorizations')
      .select('id')
      .where('id', '=', authorizationId)
      .where('organization_id', '=', organizationId)
      .where('provider', '=', 'google')
      .executeTakeFirst();
    if (!authorization)
      throw AppException.notFound(ErrorCode.NOT_FOUND, 'Google authorization not found');
    return this.database.transaction(async (trx) => {
      const integrationId = randomUUID();
      const integration = await trx
        .insertInto('capere.integrations')
        .values({
          id: integrationId,
          organization_id: organizationId,
          ghl_location_id: null,
          provider: dto.provider,
          account_id: dto.resourceId,
          account_name: dto.resourceName ?? null,
          status: 'connected',
          encrypted_credentials: null,
          key_version: this.crypto.keyVersion,
          scopes: 'read',
          token_type: 'Bearer',
          expires_at: null,
          last_sync_at: null,
          last_error: null,
          provider_metadata: JSON.stringify({
            siteUrl: dto.siteUrl ?? null,
            parentAccount: dto.parentAccount ?? null,
          }),
          authorization_id: authorizationId,
          sync_enabled: true,
        })
        .onConflict((c) =>
          c
            .columns(['organization_id', 'provider', 'account_id'])
            .where('provider', '<>', 'go_high_level')
            .doUpdateSet({
              account_id: dto.resourceId,
              account_name: dto.resourceName ?? null,
              status: 'connected',
              authorization_id: authorizationId,
              provider_metadata: JSON.stringify({
                siteUrl: dto.siteUrl ?? null,
                parentAccount: dto.parentAccount ?? null,
              }),
              sync_enabled: true,
            }),
        )
        .returning(['id', 'provider', 'account_id', 'account_name', 'status'])
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
        },
      });
      await trx
        .insertInto('capere.scheduled_jobs')
        .values({
          organization_id: organizationId,
          job_type: 'google-sync',
          name: `google-sync:${integration.id}`,
          schedule: 'daily',
          enabled: true,
          next_run_at: new Date(),
          payload: JSON.stringify({ integrationId: integration.id }),
        })
        .onConflict((c) =>
          c.columns(['organization_id', 'name']).doUpdateSet({
            enabled: true,
            next_run_at: new Date(),
            payload: JSON.stringify({ integrationId: integration.id }),
          }),
        )
        .execute();
      return integration;
    });
  }

  async listResources(organizationId: string, authorizationId: string) {
    return this.database.db
      .selectFrom('capere.integrations')
      .select(['id', 'provider', 'account_id', 'account_name', 'status', 'provider_metadata'])
      .where('organization_id', '=', organizationId)
      .where('authorization_id', '=', authorizationId)
      .execute();
  }

  async discoverResources(
    organizationId: string,
    authorizationId: string,
  ): Promise<GoogleDiscoveryResponseDto> {
    const token = await this.tokens.accessToken(organizationId, authorizationId);
    const [ga4, gsc, gbp] = await Promise.all([
      this.discoverProvider('ga4', () =>
        this.google.getJson<{
          accountSummaries?: Array<{
            propertySummaries?: Array<{ property?: string; displayName?: string }>;
          }>;
        }>('https://analyticsadmin.googleapis.com/v1alpha/accountSummaries', token),
      ),
      this.discoverProvider('gsc', () =>
        this.google.getJson<{
          siteEntry?: Array<{ siteUrl?: string; permissionLevel?: string }>;
        }>('https://www.googleapis.com/webmasters/v3/sites', token),
      ),
      this.discoverProvider('gbp', () => this.discoverGbp(token)),
    ]);

    const warnings = [ga4.warning, gsc.warning, gbp.warning].filter(
      (warning): warning is GoogleDiscoveryWarningDto => warning !== undefined,
    );

    return {
      ga4: (ga4.value?.accountSummaries ?? []).flatMap((account) =>
        (account.propertySummaries ?? []).map((property) => ({
          id: property.property,
          name: property.displayName,
        })),
      ),
      gsc: (gsc.value?.siteEntry ?? []).map((site) => ({
        id: site.siteUrl,
        name: site.siteUrl,
        permission: site.permissionLevel,
      })),
      gbp: gbp.value?.resources ?? [],
      warnings: [...warnings, ...(gbp.value?.warnings ?? [])],
    };
  }

  async autoConnectResources(organizationId: string, authorizationId: string) {
    const [resources, target] = await Promise.all([
      this.discoverResources(organizationId, authorizationId),
      this.googleMatchTarget(organizationId),
    ]);
    const candidates: Array<{ provider: ConnectGoogleResourceDto['provider']; resource?: ConnectGoogleResourceDto }> = [
      {
        provider: 'google_analytics_4',
        resource: this.matchNamedResource(resources.ga4, target, 'google_analytics_4'),
      },
      {
        provider: 'google_search_console',
        resource: this.matchSearchConsole(resources.gsc, target),
      },
      {
        provider: 'google_business_profile',
        resource: this.matchGbp(resources.gbp, target),
      },
    ];
    const connected = [];
    const unmatched = [];
    for (const candidate of candidates) {
      if (!candidate.resource) {
        unmatched.push(candidate.provider);
        continue;
      }
      connected.push(
        await this.connectResource(organizationId, authorizationId, candidate.resource),
      );
    }
    return { connected, unmatched, warnings: resources.warnings };
  }

  private async googleMatchTarget(organizationId: string): Promise<AutoMatchTarget> {
    const organization = await this.database.db
      .selectFrom('capere.organizations')
      .select('name')
      .where('id', '=', organizationId)
      .executeTakeFirstOrThrow();
    const integration = await this.database.db
      .selectFrom('capere.integrations as i')
      .leftJoin('capere.ghl_locations as l', 'l.id', 'i.ghl_location_id')
      .select(['i.id', 'l.name'])
      .where('i.organization_id', '=', organizationId)
      .where('i.provider', '=', 'go_high_level')
      .where('i.status', '=', 'connected')
      .executeTakeFirst();
    let website: string | undefined;
    let liveName: string | undefined;
    if (integration) {
      try {
        const credentials = await this.ghlTokens.credentials(organizationId, integration.id);
        const row = await this.database.db
          .selectFrom('capere.ghl_locations')
          .select('ghl_location_id')
          .where('organization_id', '=', organizationId)
          .executeTakeFirst();
        if (row) {
          const location = await this.ghl.getLocation(credentials, row.ghl_location_id);
          website = location.website;
          liveName = location.name;
        }
      } catch {
        // Matching can still use the persisted organization/location names.
      }
    }
    return {
      names: [organization.name, integration?.name, liveName].filter(
        (name): name is string => Boolean(name?.trim()),
      ),
      domain: normalizedDomain(website),
    };
  }

  private matchNamedResource(
    resources: Array<{ id?: string; name?: string }>,
    target: AutoMatchTarget,
    provider: ConnectGoogleResourceDto['provider'],
  ): ConnectGoogleResourceDto | undefined {
    const valid = resources.filter((resource): resource is { id: string; name?: string } => Boolean(resource.id));
    const matched = this.uniqueNameMatch(valid, target.names);
    const selected = matched ?? (valid.length === 1 ? valid[0] : undefined);
    return selected
      ? { provider, resourceId: selected.id, resourceName: selected.name }
      : undefined;
  }

  private matchSearchConsole(
    resources: GoogleDiscoveryResponseDto['gsc'],
    target: AutoMatchTarget,
  ): ConnectGoogleResourceDto | undefined {
    const valid = resources.filter((resource): resource is { id: string; name?: string } => Boolean(resource.id));
    const domainMatches = target.domain
      ? valid.filter((resource) => normalizedDomain(resource.id) === target.domain)
      : [];
    const selected = domainMatches.length === 1 ? domainMatches[0] : valid.length === 1 ? valid[0] : undefined;
    return selected
      ? {
          provider: 'google_search_console',
          resourceId: selected.id,
          resourceName: selected.name,
          siteUrl: selected.id.startsWith('http') ? selected.id : undefined,
        }
      : undefined;
  }

  private matchGbp(
    resources: GoogleDiscoveryResponseDto['gbp'],
    target: AutoMatchTarget,
  ): ConnectGoogleResourceDto | undefined {
    const valid = resources.filter((resource): resource is { id: string; name?: string; parentAccount?: string } => Boolean(resource.id));
    const matched = this.uniqueNameMatch(valid, target.names);
    const selected = matched ?? (valid.length === 1 ? valid[0] : undefined);
    return selected
      ? {
          provider: 'google_business_profile',
          resourceId: selected.id,
          resourceName: selected.name,
          parentAccount: selected.parentAccount,
        }
      : undefined;
  }

  private uniqueNameMatch<T extends { name?: string }>(resources: T[], names: readonly string[]): T | undefined {
    const targets = names.map(normalizedBusinessName).filter(Boolean);
    const exact = resources.filter((resource) => targets.includes(normalizedBusinessName(resource.name)));
    if (exact.length === 1) return exact[0];
    const partial = resources.filter((resource) => {
      const name = normalizedBusinessName(resource.name);
      return name.length >= 4 && targets.some((target) => target.includes(name) || name.includes(target));
    });
    return partial.length === 1 ? partial[0] : undefined;
  }

  private async discoverGbp(token: string) {
    const accounts = await this.google.getJson<{
      accounts?: Array<{ name?: string; accountName?: string }>;
    }>('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', token);
    const locationResults = await Promise.all(
      (accounts.accounts ?? [])
        .filter((account) => account.name)
        .map(async (account) => {
          const parentAccount = account.name as string;
          return this.discoverProvider(
            'gbp',
            async () => {
              const locations = await this.google.getJson<{
                locations?: Array<{ name?: string; title?: string }>;
              }>(
                `https://mybusinessbusinessinformation.googleapis.com/v1/${parentAccount}/locations?readMask=name,title`,
                token,
              );
              return (locations.locations ?? []).map((location) => ({
                id: location.name,
                name: location.title,
                account: account.accountName,
                parentAccount,
              }));
            },
            parentAccount,
          );
        }),
    );
    return {
      resources: locationResults.flatMap((result) => result.value ?? []),
      warnings: locationResults
        .map((result) => result.warning)
        .filter((warning): warning is GoogleDiscoveryWarningDto => warning !== undefined),
    };
  }

  private async discoverProvider<T>(
    provider: GoogleResourceProvider,
    operation: () => Promise<T>,
    resourceId?: string,
  ): Promise<DiscoveryResult<T>> {
    try {
      return { value: await operation() };
    } catch (error) {
      if (!(error instanceof ProviderAdapterError)) throw error;
      if (error.kind === 'unauthorized') {
        throw AppException.unauthorized(
          ErrorCode.INTEGRATION_ERROR,
          'Google authorization is no longer valid; reconnect Google',
        );
      }
      if (error.kind === 'invalid') {
        throw AppException.badRequest(
          ErrorCode.INTEGRATION_ERROR,
          `${provider.toUpperCase()} resource discovery request was rejected`,
        );
      }
      return {
        warning: {
          provider,
          code: error.kind.toUpperCase() as GoogleDiscoveryWarningDto['code'],
          message: `${provider.toUpperCase()} resource discovery is temporarily unavailable`,
          ...(resourceId !== undefined ? { resourceId } : {}),
          ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
        },
      };
    }
  }
}
