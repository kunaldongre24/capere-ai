import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApiKeyService } from '../../auth';
import { APP_CONFIG, type AppConfig } from '../../shared/config';
import { DatabaseService } from '../../shared/database';
import { GhlAdapter, type GhlCredentials } from './ghl.adapter';
import { GhlTokenService } from './ghl-token.service';
import { DataForSeoService } from '../dataforseo/dataforseo.service';
import { AppException, ErrorCode } from '../../shared/http';

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
    private readonly dataForSeo: DataForSeoService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async provision(params: {
    organizationId: string;
    internalLocationId: string;
    ghlLocationId: string;
    locationName?: string | null;
    website?: string | null;
    country?: string | null;
    credentials: GhlCredentials;
  }): Promise<void> {
    await this.provisionWebsite(params);
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
    const location = await this.ghl.getLocation(credentials, row.ghl_location_id);
    await this.provision({
      organizationId,
      internalLocationId: row.id,
      ghlLocationId: row.ghl_location_id,
      locationName: row.name,
      website: location.website ?? null,
      country: location.country ?? null,
      credentials,
    });
  }

  async setWebsite(organizationId: string, website: string, confirmChange: boolean) {
    const connected = await this.connectedLocation(organizationId);
    const location = connected
      ? await this.ghl.getLocation(connected.credentials, connected.ghlLocationId)
      : null;
    const normalized = this.normalizeWebsite(website);
    const active = await this.activeProject(organizationId);
    if (active && this.websiteIdentity(active.site_url) === this.websiteIdentity(normalized)) {
      return { project:active, status:'connected' as const };
    }
    if (active && !confirmChange) {
      throw AppException.conflict(ErrorCode.CONFLICT, 'Confirm before changing the website used for SEO reports');
    }
    const project = await this.dataForSeo.createProject(organizationId, {
      name: location?.name?.trim() || active?.name || 'My website',
      siteUrl: normalized,
      targetLocationCode: this.locationCode(location?.country),
      languageCode: 'en',
    });
    if (active && active.id !== project.id) {
      const obsolete = await this.database.db.selectFrom('capere.seo_projects').select('id').where('organization_id','=',organizationId).where('id','<>',project.id).where('enabled','=',true).execute();
      await this.database.transaction(async (trx) => {
        await trx.updateTable('capere.seo_projects').set({ enabled:false, updated_at:new Date() }).where('organization_id','=',organizationId).where('id','<>',project.id).execute();
        for (const row of obsolete) {
          await trx.updateTable('capere.scheduled_jobs').set({ enabled:false, updated_at:new Date() }).where('organization_id','=',organizationId).where('name','in',[`dataforseo-audit:${row.id}`,`dataforseo-keywords:${row.id}`,`dataforseo-competitors:${row.id}`]).execute();
        }
      });
    }
    return { project, status:'connected' as const };
  }

  async websiteStatus(organizationId:string) {
    let active = await this.activeProject(organizationId);
    const connected = await this.connectedLocation(organizationId);
    if (!connected) return { status:active?'connected':'unavailable', currentWebsite:active?.site_url??null, ghlWebsite:null, message:active?'Your website review is active.':'GoHighLevel is not connected.' };
    try {
      const location = await this.ghl.getLocation(connected.credentials, connected.ghlLocationId);
      const ghlWebsite = location.website ? this.normalizeWebsite(location.website) : null;
      if (!active && ghlWebsite) {
        const provisioning = await this.provisionWebsite({ organizationId, locationName:location.name, website:ghlWebsite, country:location.country });
        active = await this.activeProject(organizationId);
        if (!active) return { status:provisioning==='failed'?'unavailable' as const:'provisioning' as const, currentWebsite:null, ghlWebsite, message:provisioning==='failed'?'We found your GoHighLevel website but could not verify it. Check that the website opens publicly and try again.':'Your website was found and the first review is being prepared.' };
      }
      if (!active) return { status:'missing' as const, currentWebsite:null, ghlWebsite, message:'Add your website to begin the first review.' };
      if (ghlWebsite && this.websiteIdentity(active.site_url) !== this.websiteIdentity(ghlWebsite)) return { status:'change_pending' as const, currentWebsite:active.site_url, ghlWebsite, message:'GoHighLevel has a different website. Confirm before starting reports for the new site.' };
      return { status:'connected' as const, currentWebsite:active.site_url, ghlWebsite, message:'Your website is connected and monitored automatically.' };
    } catch (error) {
      return { status:active?'connected' as const:'unavailable' as const, currentWebsite:active?.site_url??null, ghlWebsite:null, message:active?'Your website review remains active. GoHighLevel website details are temporarily unavailable.':'Website details are temporarily unavailable.' };
    }
  }

  private async provisionWebsite(params: { organizationId:string; locationName?:string|null; website?:string|null; country?:string|null }) {
    if (!params.website) return 'skipped' as const;
    const active = await this.activeProject(params.organizationId);
    if (active) return 'skipped' as const;
    try {
      await this.dataForSeo.createProject(params.organizationId, {
        name: params.locationName?.trim() || 'My website',
        siteUrl: this.normalizeWebsite(params.website),
        targetLocationCode: this.locationCode(params.country),
        languageCode: 'en',
      });
      this.logger.log(`Provisioned SEO website for organization ${params.organizationId}`);
      return 'created' as const;
    } catch (error) {
      this.logger.warn(`SEO website provisioning failed for ${params.organizationId}: ${error instanceof Error ? error.message : String(error)}`);
      return 'failed' as const;
    }
  }

  private activeProject(organizationId:string) {
    return this.database.db.selectFrom('capere.seo_projects').select(['id','name','site_url']).where('organization_id','=',organizationId).where('enabled','=',true).orderBy('created_at','desc').executeTakeFirst();
  }

  private async connectedLocation(organizationId:string) {
    const row = await this.database.db.selectFrom('capere.integrations').select(['id','account_id']).where('organization_id','=',organizationId).where('provider','=','go_high_level').where('status','=','connected').orderBy('created_at').executeTakeFirst();
    if (!row?.account_id) return null;
    return { ghlLocationId:row.account_id, credentials:await this.tokens.credentials(organizationId,row.id) };
  }

  private normalizeWebsite(value:string) {
    try {
      const candidate = value.trim().includes('://') ? value.trim() : `https://${value.trim()}`;
      const url = new URL(candidate);
      if (!['http:','https:'].includes(url.protocol) || !url.hostname.includes('.')) throw new Error();
      return url.origin;
    } catch { throw AppException.badRequest(ErrorCode.BAD_REQUEST,'Enter a valid website address'); }
  }

  private websiteIdentity(value:string) {
    return new URL(this.normalizeWebsite(value)).hostname.toLowerCase().replace(/^www\./,'');
  }

  private locationCode(country?:string|null) {
    const key=(country??'').trim().toLowerCase();
    const codes:Record<string,number>={us:2840,usa:2840,'united states':2840,ca:2124,canada:2124,gb:2826,uk:2826,'united kingdom':2826,au:2036,australia:2036,in:2356,india:2356};
    return codes[key] ?? 2356;
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
