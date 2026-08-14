import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GhlSeoDashboardProvisioningService } from '../src/integrations/ghl/ghl-seo-dashboard-provisioning.service';
import type { ApiKeyService } from '../src/auth';
import type { DataForSeoService } from '../src/integrations/dataforseo/dataforseo.service';
import type { GhlAdapter } from '../src/integrations/ghl/ghl.adapter';
import type { GhlTokenService } from '../src/integrations/ghl/ghl-token.service';
import type { AppConfig } from '../src/shared/config';
import type { DatabaseService } from '../src/shared/database';
import { cleanup, closeDb, seedTwoOrganizations, serviceDb, type Fixture } from './helpers/database';

function database(): DatabaseService {
  return { db:serviceDb(), transaction:(fn)=>serviceDb().transaction().execute(fn) } as DatabaseService;
}

describe('GHL SEO website provisioning', () => {
  let fixture:Fixture;

  beforeEach(async()=>{
    fixture=await seedTwoOrganizations();
    const location=await serviceDb().insertInto('capere.ghl_locations').values({organization_id:fixture.orgAId,ghl_location_id:`location-${fixture.orgAId}`,name:'Client Firm',timezone:'Asia/Kolkata',is_primary:true}).returning('id').executeTakeFirstOrThrow();
    await serviceDb().insertInto('capere.integrations').values({organization_id:fixture.orgAId,ghl_location_id:location.id,provider:'go_high_level',account_id:`location-${fixture.orgAId}`,account_name:'Client Firm',status:'connected',encrypted_credentials:null,key_version:1,scopes:'read_write',token_type:'Bearer',expires_at:null,last_sync_at:null,last_error:null,provider_metadata:JSON.stringify({}),authorization_id:null,sync_enabled:true}).execute();
  });
  afterEach(async()=>{await cleanup(fixture);vi.restoreAllMocks();});
  afterAll(closeDb);

  function service(location:Record<string,unknown>, createProject?:DataForSeoService['createProject']) {
    const ghl={getLocation:vi.fn().mockResolvedValue(location)} as unknown as GhlAdapter;
    const tokens={credentials:vi.fn().mockResolvedValue({accessToken:'token'})} as unknown as GhlTokenService;
    const dataForSeo={createProject:createProject??vi.fn()} as unknown as DataForSeoService;
    return new GhlSeoDashboardProvisioningService(database(),{} as ApiKeyService,ghl,tokens,dataForSeo,{webUrl:'https://app.capereai.com'} as AppConfig);
  }

  it('creates the first project automatically from the connected GHL website',async()=>{
    const createProject=vi.fn(async(organizationId:string,dto:{name:string;siteUrl:string;targetLocationCode:number;languageCode:string})=>serviceDb().insertInto('capere.seo_projects').values({organization_id:organizationId,name:dto.name,site_url:dto.siteUrl,target_location_code:dto.targetLocationCode,language_code:dto.languageCode,enabled:true}).returningAll().executeTakeFirstOrThrow());
    const subject=service({id:`location-${fixture.orgAId}`,name:'Client Firm',website:'https://client.example/',country:'India'},createProject as DataForSeoService['createProject']);
    const status=await subject.websiteStatus(fixture.orgAId);
    expect(status).toMatchObject({status:'connected',currentWebsite:'https://client.example'});
    expect(createProject).toHaveBeenCalledWith(fixture.orgAId,{name:'Client Firm',siteUrl:'https://client.example',targetLocationCode:2356,languageCode:'en'});
  });

  it('asks for a website when the GHL location has none',async()=>{
    const subject=service({id:`location-${fixture.orgAId}`,name:'Client Firm',website:null,country:'India'});
    await expect(subject.websiteStatus(fixture.orgAId)).resolves.toMatchObject({status:'missing',currentWebsite:null,ghlWebsite:null});
  });

  it('requires confirmation when GHL reports a different domain',async()=>{
    await serviceDb().insertInto('capere.seo_projects').values({organization_id:fixture.orgAId,name:'Current site',site_url:'https://current.example',target_location_code:2356,language_code:'en',enabled:true}).execute();
    const subject=service({id:`location-${fixture.orgAId}`,name:'Client Firm',website:'https://new.example/',country:'India'});
    await expect(subject.websiteStatus(fixture.orgAId)).resolves.toMatchObject({status:'change_pending',currentWebsite:'https://current.example',ghlWebsite:'https://new.example'});
  });
});
