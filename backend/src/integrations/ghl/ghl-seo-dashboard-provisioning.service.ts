import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApiKeyService } from '../../auth';
import { APP_CONFIG, type AppConfig } from '../../shared/config';
import { DatabaseService } from '../../shared/database';
import { GhlAdapter, type GhlCredentials } from './ghl.adapter';
import { GhlTokenService } from './ghl-token.service';

const PURPOSE = 'seo_dashboard';
const CUSTOM_VALUE_NAME = 'Capere SEO Dashboard URL';

@Injectable()
export class GhlSeoDashboardProvisioningService {
  private readonly logger = new Logger(GhlSeoDashboardProvisioningService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly apiKeys: ApiKeyService,
    private readonly ghl: GhlAdapter,
    private readonly tokens: GhlTokenService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async provision(params: {
    organizationId: string;
    internalLocationId: string;
    ghlLocationId: string;
    locationName?: string | null;
    credentials: GhlCredentials;
  }): Promise<void> {
    const values = await this.ghl.getCustomValues(params.credentials, params.ghlLocationId);
    const current = values.find((item) =>
      item.name.trim().toLowerCase() === CUSTOM_VALUE_NAME.toLowerCase() ||
      item.fieldKey?.toLowerCase().includes('capere_seo_dashboard_url'),
    );

    if (current?.value && await this.isActiveUrl(current.value, params)) return;

    const issued = await this.apiKeys.issue({
      organizationId: params.organizationId,
      name: `SEO dashboard · ${params.locationName ?? params.ghlLocationId}`,
      roles: ['seo_specialist'],
      issuerRole: 'capere_admin',
      ghlLocationId: params.internalLocationId,
      purpose: PURPOSE,
    });
    const url = `${this.config.webUrl.replace(/\/$/, '')}/embed/seo-dashboard?key=${encodeURIComponent(issued.rawKey)}`;
    try {
      if (current) {
        await this.ghl.updateCustomValue(
          params.credentials,
          params.ghlLocationId,
          current.id,
          CUSTOM_VALUE_NAME,
          url,
        );
      } else {
        await this.ghl.createCustomValue(
          params.credentials,
          params.ghlLocationId,
          CUSTOM_VALUE_NAME,
          url,
        );
      }
    } catch (error) {
      await this.apiKeys.revoke(issued.id, params.organizationId);
      throw error;
    }

    if (current?.value) await this.revokeKeyFromUrl(current.value, params.organizationId);
    this.logger.log(`Provisioned SEO dashboard URL for GHL location ${params.ghlLocationId}`);
  }

  async provisionConnectedLocation(organizationId: string, ghlLocationId: string): Promise<void> {
    const row = await this.database.db
      .selectFrom('capere.ghl_locations as l')
      .innerJoin('capere.integrations as i', (join) =>
        join
          .onRef('i.organization_id', '=', 'l.organization_id')
          .onRef('i.ghl_location_id', '=', 'l.id')
          .on('i.provider', '=', 'go_high_level')
          .on('i.status', '=', 'connected'),
      )
      .select(['l.id', 'l.name', 'l.ghl_location_id', 'i.id as integration_id'])
      .where('l.organization_id', '=', organizationId)
      .where('l.ghl_location_id', '=', ghlLocationId)
      .executeTakeFirst();
    if (!row) return;
    const credentials = await this.tokens.credentials(organizationId, row.integration_id);
    await this.provision({
      organizationId,
      internalLocationId: row.id,
      ghlLocationId: row.ghl_location_id,
      locationName: row.name,
      credentials,
    });
  }

  private async isActiveUrl(
    value: string,
    params: { organizationId: string; internalLocationId: string },
  ): Promise<boolean> {
    const key = this.keyFromUrl(value);
    if (!key) return false;
    try {
      const resolved = await this.apiKeys.verifyForPurpose(key, PURPOSE);
      return resolved.organizationId === params.organizationId &&
        resolved.ghlLocationId === params.internalLocationId;
    } catch {
      return false;
    }
  }

  private async revokeKeyFromUrl(value: string, organizationId: string): Promise<void> {
    const key = this.keyFromUrl(value);
    if (!key) return;
    try {
      const resolved = await this.apiKeys.verifyForPurpose(key, PURPOSE);
      if (resolved.organizationId === organizationId)
        await this.apiKeys.revoke(resolved.apiKeyId, organizationId);
    } catch {
      // An invalid or already revoked old value needs no further cleanup.
    }
  }

  private keyFromUrl(value: string): string | null {
    try {
      const url = new URL(value);
      if (url.origin !== new URL(this.config.webUrl).origin || url.pathname !== '/embed/seo-dashboard')
        return null;
      return url.searchParams.get('key');
    } catch {
      return null;
    }
  }
}
