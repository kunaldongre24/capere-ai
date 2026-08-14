import { Inject, Injectable } from '@nestjs/common';
import { SignJWT, jwtVerify } from 'jose';
import { ApiKeyService } from '../auth';
import { APP_CONFIG, type AppConfig } from '../shared/config';
import { DatabaseService } from '../shared/database';
import { AppException, ErrorCode } from '../shared/http';
import { DashboardService } from './dashboard.service';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { sql } from 'kysely';

const PURPOSE = 'seo_dashboard';
const AUDIENCE = 'capere-seo-dashboard';

@Injectable()
export class SeoDashboardEmbedService {
  private readonly signingKey: Uint8Array;

  constructor(
    private readonly database: DatabaseService,
    private readonly apiKeys: ApiKeyService,
    private readonly dashboards: DashboardService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.signingKey = new TextEncoder().encode(config.auth.apiKeyHashingSalt);
  }

  async locations(organizationId: string) {
    return this.database.db.selectFrom('capere.ghl_locations').select(['id','ghl_location_id','name','is_primary'])
      .where('organization_id','=',organizationId).orderBy('is_primary','desc').orderBy('name').execute();
  }

  async list(organizationId: string) {
    return this.database.db.selectFrom('capere.api_keys as k').leftJoin('capere.ghl_locations as l','l.id','k.ghl_location_id')
      .select(['k.id','k.name','k.key_prefix','k.created_at','k.last_used_at','k.revoked_at','l.ghl_location_id','l.name as location_name'])
      .where('k.organization_id','=',organizationId).where('k.purpose','=',PURPOSE).orderBy('k.created_at','desc').execute();
  }

  async create(organizationId: string, userId: string, issuerRole: Parameters<ApiKeyService['issue']>[0]['issuerRole'], ghlLocationId: string, label?: string) {
    const location = await this.database.db.selectFrom('capere.ghl_locations').select(['id','name','ghl_location_id'])
      .where('organization_id','=',organizationId).where('ghl_location_id','=',ghlLocationId).executeTakeFirst();
    if (!location) throw AppException.notFound(ErrorCode.NOT_FOUND, 'GoHighLevel location was not found');
    const issued = await this.apiKeys.issue({ organizationId, name: label?.trim() || `SEO dashboard · ${location.name ?? location.ghl_location_id}`, roles:['seo_specialist'], issuerRole, createdBy:userId, ghlLocationId:location.id, purpose:PURPOSE });
    return { id:issued.id, locationId:location.ghl_location_id, locationName:location.name, iframeUrl:`${this.config.webUrl.replace(/\/$/,'')}/embed/seo-dashboard?key=${encodeURIComponent(issued.rawKey)}` };
  }

  async revoke(organizationId: string, id: string) { await this.apiKeys.revoke(id, organizationId); return { revoked:true }; }

  async exchange(rawKey: string) {
    const resolved = await this.apiKeys.verifyForPurpose(rawKey, PURPOSE);
    const token = await new SignJWT({ org:resolved.organizationId, loc:resolved.ghlLocationId, kid:resolved.apiKeyId })
      .setProtectedHeader({ alg:'HS256' }).setAudience(AUDIENCE).setIssuer('capere').setIssuedAt().setExpirationTime('1h').sign(this.signingKey);
    if (this.config.identity.provider !== 'firebase') return { token, expiresInSeconds:3600 };

    // The dashboard key is already bound to one active organization and GHL
    // location. Give that location a stable, non-human Firebase identity so
    // the existing full SEO application can be reused without a login screen.
    const uid = resolved.ghlLocationId!;
    const email = `seo-dashboard-${uid}@embedded.capereai.com`;
    if (!getApps().length)
      initializeApp({ credential: applicationDefault(), projectId: this.config.identity.firebaseProjectId });
    const auth = getAuth();
    try {
      await auth.getUser(uid);
      await auth.updateUser(uid, { email, displayName: 'Search Visibility Dashboard', disabled: false });
    } catch (error) {
      if ((error as { code?: string })?.code !== 'auth/user-not-found') throw error;
      await auth.createUser({ uid, email, displayName: 'Search Visibility Dashboard', emailVerified: true });
    }
    await this.database.transaction(async (trx) => {
      await sql`INSERT INTO auth.users (id, email) VALUES (${uid}::uuid, ${email}) ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`.execute(trx);
      await trx.insertInto('capere.users').values({ id:uid, email, full_name:'Search Visibility Dashboard', avatar_url:null, last_seen_at:new Date() }).onConflict((conflict)=>conflict.column('id').doUpdateSet({ email, full_name:'Search Visibility Dashboard', last_seen_at:new Date(), updated_at:new Date() })).execute();
      await trx.insertInto('capere.organization_members').values({ organization_id:resolved.organizationId, user_id:uid, role:'seo_specialist', invited_by:null }).onConflict((conflict)=>conflict.columns(['organization_id','user_id']).doUpdateSet({ role:'seo_specialist' })).execute();
    });
    const customToken = await auth.createCustomToken(uid, {
      ghl_location_id: resolved.ghlLocationId,
      dashboard_embed: true,
    });
    return { token, customToken, organizationId:resolved.organizationId, expiresInSeconds:3600 };
  }

  async summary(token: string) {
    let payload: Record<string,unknown>;
    try { payload = (await jwtVerify(token,this.signingKey,{audience:AUDIENCE,issuer:'capere'})).payload as Record<string,unknown>; }
    catch { throw AppException.unauthorized(ErrorCode.INVALID_TOKEN,'Dashboard session is invalid or expired'); }
    if (typeof payload.org!=='string'||typeof payload.loc!=='string'||typeof payload.kid!=='string') throw AppException.unauthorized(ErrorCode.INVALID_TOKEN,'Dashboard session is invalid');
    const active = await this.database.db.selectFrom('capere.api_keys as k')
      .innerJoin('capere.integrations as i',(join)=>join.onRef('i.organization_id','=','k.organization_id').onRef('i.ghl_location_id','=','k.ghl_location_id').on('i.provider','=','go_high_level').on('i.status','=','connected'))
      .select('k.id').where('k.id','=',payload.kid).where('k.organization_id','=',payload.org).where('k.ghl_location_id','=',payload.loc).where('k.purpose','=',PURPOSE).where('k.revoked_at','is',null).where((eb)=>eb.or([eb('k.expires_at','is',null),eb('k.expires_at','>',new Date())])).executeTakeFirst();
    if (!active) throw AppException.unauthorized(ErrorCode.INVALID_TOKEN,'Dashboard access has been revoked');
    const full = await this.dashboards.seoCommandCenter(payload.org);
    const metrics = full.metrics as Array<{metric_name:string;metric_value:string;metric_date:string}>;
    const latest=(name:string)=>metrics.find((m)=>m.metric_name===name)?.metric_value ?? (name==='position'?'—':'0');
    const audit = full.technicalAudit as null|{score:number|null;issue_count:number|null;completed_at:string|null;site_url?:string};
    const tech = full.technicalOverview as null|{pagesCrawled:number;totalPages:number;crawlLimit:number};
    const clicksByDate = new Map<string,number>();
    for(const row of metrics.filter((m)=>m.metric_name==='clicks').reverse()) clicksByDate.set(String(row.metric_date).slice(0,10),(clicksByDate.get(String(row.metric_date).slice(0,10))??0)+Number(row.metric_value||0));
    return { generatedAt:full.generatedAt, website:(full.project as null|{site_url:string})?.site_url??audit?.site_url??null, clicks:latest('clicks'), impressions:latest('impressions'), position:latest('position'), healthScore:audit?.score??null, issueCount:audit?.issue_count??0, auditCompletedAt:audit?.completed_at??null, pagesCrawled:tech?.pagesCrawled??0, crawlTarget:tech?Math.max(tech.pagesCrawled,Math.min(tech.totalPages,tech.crawlLimit)):0, trend:[...clicksByDate.entries()].map(([date,value])=>({date,value})), recommendations:(full.technicalFindings as Array<{title:string;severity:string;action:string}>).slice(0,3) };
  }
}
