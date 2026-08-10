import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../shared/config';
import { sql } from 'kysely';
import { DatabaseService } from '../../shared/database';
import { EventType, OutboxService } from '../../shared/events';
import { AppException, ErrorCode } from '../../shared/http';
import { DataForSeoAdapter } from './dataforseo.adapter';
import type { CreateCompetitorDto, CreateSeoProjectDto, RunSeoAuditDto } from './dataforseo.dto';

@Injectable()
export class DataForSeoService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly database: DatabaseService,
    private readonly adapter: DataForSeoAdapter,
    private readonly outbox: OutboxService,
  ) {}

  private async ensurePlatformIntegration(organizationId: string) {
    return this.database.db
      .insertInto('capere.integrations')
      .values({
        organization_id: organizationId,
        ghl_location_id: null,
        provider: 'data_for_seo',
        account_id: 'capere-platform',
        account_name: 'Capere DataForSEO',
        status: 'connected',
        encrypted_credentials: null,
        key_version: 1,
        scopes: 'read',
        token_type: 'Basic',
        expires_at: null,
        last_sync_at: null,
        last_error: null,
        provider_metadata: JSON.stringify({ billingOwner: 'capere' }),
        authorization_id: null,
        sync_enabled: true,
      })
      .onConflict((c) =>
        c
          .columns(['organization_id', 'provider', 'account_id'])
          .where('provider', '<>', 'go_high_level')
          .doUpdateSet({ status: 'connected', last_error: null }),
      )
      .returning(['id', 'provider', 'status'])
      .executeTakeFirstOrThrow();
  }

  async addCompetitor(organizationId: string, projectId: string, dto: CreateCompetitorDto) {
    const project = await this.database.db.selectFrom('capere.seo_projects').select('id').where('organization_id','=',organizationId).where('id','=',projectId).executeTakeFirst();
    if (!project) throw AppException.notFound(ErrorCode.NOT_FOUND, 'SEO project not found');
    let domain = dto.domain.trim().toLowerCase();
    try { domain = new URL(domain.includes('://') ? domain : `https://${domain}`).hostname.toLowerCase().replace(/^www\./,'').replace(/\.$/,''); } catch { throw AppException.badRequest(ErrorCode.BAD_REQUEST, 'Enter a valid competitor website'); }
    if (!domain || domain.includes(' ')) throw AppException.badRequest(ErrorCode.BAD_REQUEST, 'Enter a valid competitor website');
    const existing = await this.database.db.selectFrom('capere.competitors').select('id').where('organization_id','=',organizationId).where('seo_project_id','=',projectId).where('domain','=',domain).executeTakeFirst();
    const count = await this.database.db.selectFrom('capere.competitors').select((eb) => eb.fn.countAll<number>().as('count')).where('organization_id','=',organizationId).where('seo_project_id','=',projectId).executeTakeFirstOrThrow();
    if (!existing && Number(count.count) >= 10) throw AppException.badRequest(ErrorCode.BAD_REQUEST, 'You can compare up to 10 businesses per website');
    const competitor = await this.database.db.insertInto('capere.competitors').values({ organization_id: organizationId, seo_project_id: projectId, domain, name: dto.name.trim(), metrics: JSON.stringify({ status: 'configured', message: 'Comparison data will appear after the next refresh.' }), last_checked_at: null }).onConflict((c)=>c.columns(['organization_id','seo_project_id','domain']).doUpdateSet({name:dto.name.trim(),updated_at:new Date()})).returningAll().executeTakeFirstOrThrow();
    await this.database.db.insertInto('capere.scheduled_jobs').values({ organization_id: organizationId, job_type: 'dataforseo-competitor-refresh', name: `dataforseo-competitors:${projectId}`, schedule: 'weekly', enabled: true, next_run_at: new Date(Date.now() + 7 * 86_400_000), payload: JSON.stringify({ projectId }) }).onConflict((oc) => oc.columns(['organization_id','name']).doUpdateSet({ enabled: true, payload: JSON.stringify({ projectId }) })).execute();
    await this.refreshCompetitors(organizationId, projectId);
    return this.database.db.selectFrom('capere.competitors').selectAll().where('organization_id','=',organizationId).where('id','=',competitor.id).executeTakeFirstOrThrow();
  }

  async refreshCompetitors(organizationId: string, projectId: string) {
    const project = await this.database.db.selectFrom('capere.seo_projects').selectAll().where('organization_id','=',organizationId).where('id','=',projectId).executeTakeFirst();
    if (!project) throw AppException.notFound(ErrorCode.NOT_FOUND, 'SEO project not found');
    const competitors = await this.database.db.selectFrom('capere.competitors').selectAll().where('organization_id','=',organizationId).where('seo_project_id','=',projectId).orderBy('created_at').limit(10).execute();
    if (!competitors.length) return { refreshed: 0, message: 'Add at least one competitor before refreshing comparisons.' };
    const cooldown = Date.now() - 6 * 3_600_000;
    if (competitors.every((competitor) => competitor.last_checked_at && new Date(competitor.last_checked_at).getTime() >= cooldown)) return { refreshed: 0, cached: true, message: 'Comparison data is already current.' };
    const target = new URL(project.site_url).hostname.toLowerCase().replace(/^www\./, '');
    const request = { targets: [target, ...competitors.map((c) => c.domain)], location_code: project.target_location_code, language_code: project.language_code };
    const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const integration = await this.ensurePlatformIntegration(organizationId);
    const response = await this.adapter.postTask<Record<string, unknown>>('dataforseo_labs/google/bulk_traffic_estimation/live', request);
    const task = response.tasks?.[0];
    const result = task?.result?.[0] as {
      items?: Array<{
        target?: string;
        metrics?: Record<string, { etv?: number; count?: number } | null>;
      }>;
    } | undefined;
    if (!result?.items) throw AppException.serviceUnavailable(ErrorCode.INTEGRATION_ERROR, 'DataForSEO did not return competitor data');
    const byTarget = new Map(result.items.map((item) => [String(item.target ?? '').replace(/^www\./, ''), item]));
    const targetItem = byTarget.get(target);
    const measurableDomains = result.items.filter((item) => Number(item.metrics?.organic?.count ?? 0) > 0).map((item) => String(item.target ?? '').replace(/^www\./, '')).slice(0, 3);
    const detailRequests = measurableDomains.map((domain) => ({ target: domain, location_code: project.target_location_code, language_code: project.language_code }));
    const [overviewResponse, keywordResponse] = detailRequests.length ? await Promise.all([
      this.adapter.postTasks<Record<string, unknown>>('dataforseo_labs/google/domain_rank_overview/live', detailRequests),
      this.adapter.postTasks<Record<string, unknown>>('dataforseo_labs/google/ranked_keywords/live', detailRequests.map((row) => ({ ...row, limit: 20, order_by: ['ranked_serp_element.serp_item.rank_absolute,asc'] }))),
    ]) : [{ tasks: [] }, { tasks: [] }];
    const details = new Map<string, Record<string, unknown>>();
    for (let index = 0; index < measurableDomains.length; index += 1) {
      const overviewRoot = this.object(overviewResponse.tasks?.[index]?.result?.[0]);
      const overviewItem = Array.isArray(overviewRoot['items']) ? this.object(overviewRoot['items'][0]) : {};
      const organic = this.object(this.object(overviewItem['metrics'])['organic']);
      const keywordRoot = this.object(keywordResponse.tasks?.[index]?.result?.[0]);
      const keywordItems = Array.isArray(keywordRoot['items']) ? keywordRoot['items'] : [];
      const topKeywords = keywordItems.map((raw) => {
        const row = this.object(raw); const keywordData = this.object(row['keyword_data']); const keywordInfo = this.object(keywordData['keyword_info']); const serp = this.object(this.object(row['ranked_serp_element'])['serp_item']);
        return { keyword: String(keywordData['keyword'] ?? ''), rank: Number(serp['rank_absolute'] ?? 0), searchVolume: Number(keywordInfo['search_volume'] ?? 0), url: String(serp['url'] ?? ''), title: String(serp['title'] ?? ''), estimatedVisits: Number(serp['etv'] ?? 0) };
      }).filter((row) => row.keyword);
      const pages = new Map<string, { url:string; title:string; estimatedVisits:number; keywords:number }>();
      for (const keyword of topKeywords) { if (!keyword.url) continue; const page = pages.get(keyword.url) ?? { url:keyword.url,title:keyword.title,estimatedVisits:0,keywords:0 }; page.estimatedVisits += keyword.estimatedVisits; page.keywords += 1; pages.set(keyword.url,page); }
      details.set(measurableDomains[index], { top3: Number(organic['pos_1'] ?? 0) + Number(organic['pos_2_3'] ?? 0), top10: Number(organic['pos_1'] ?? 0) + Number(organic['pos_2_3'] ?? 0) + Number(organic['pos_4_10'] ?? 0), trafficValue: Number(organic['estimated_paid_traffic_cost'] ?? 0), newKeywords: Number(organic['is_new'] ?? 0), improvedKeywords: Number(organic['is_up'] ?? 0), declinedKeywords: Number(organic['is_down'] ?? 0), topKeywords, topPages: [...pages.values()].sort((a,b)=>b.estimatedVisits-a.estimatedVisits).slice(0,5) });
    }
    const targetDetails = details.get(target) ?? {};
    const targetKeywordSet = new Set((Array.isArray(targetDetails['topKeywords']) ? targetDetails['topKeywords'] : []).map((row) => String(this.object(row)['keyword'] ?? '')));
    const totalTraffic = result.items.reduce((sum, item) => sum + Number(item.metrics?.organic?.etv ?? 0), 0);
    const detailCost = [...(overviewResponse.tasks ?? []), ...(keywordResponse.tasks ?? [])].reduce((sum, row) => sum + Number(row.cost ?? 0), 0);
    const checkedAt = new Date();
    await this.database.transaction(async (trx) => {
      await trx.insertInto('capere.provider_tasks').values({ organization_id: organizationId, integration_id: integration.id, provider: 'data_for_seo', task_type: 'competitor_bulk_traffic', request_fingerprint: fingerprint, provider_task_id: task?.id ?? null, status: 'succeeded', request: JSON.stringify(request), result: JSON.stringify(result), cost_micro_usd: String(Math.round((task?.cost ?? 0) * 1_000_000)), attempts: 1, next_poll_at: null, error: null }).onConflict((oc) => oc.columns(['organization_id','provider','task_type','request_fingerprint']).doUpdateSet({ result: JSON.stringify(result), status: 'succeeded', cost_micro_usd: String(Math.round((task?.cost ?? 0) * 1_000_000)), updated_at: new Date() })).execute();
      if (detailRequests.length) await trx.insertInto('capere.provider_tasks').values({ organization_id: organizationId, integration_id: integration.id, provider: 'data_for_seo', task_type: 'competitor_rank_details', request_fingerprint: createHash('sha256').update(JSON.stringify(detailRequests)).digest('hex'), provider_task_id: overviewResponse.tasks?.[0]?.id ?? null, status: 'succeeded', request: JSON.stringify(detailRequests), result: JSON.stringify({ overview: overviewResponse.tasks, keywords: keywordResponse.tasks }), cost_micro_usd: String(Math.round(detailCost * 1_000_000)), attempts: 1, next_poll_at: null, error: null }).onConflict((oc) => oc.columns(['organization_id','provider','task_type','request_fingerprint']).doUpdateSet({ result: JSON.stringify({ overview: overviewResponse.tasks, keywords: keywordResponse.tasks }), status: 'succeeded', cost_micro_usd: String(Math.round(detailCost * 1_000_000)), updated_at: new Date() })).execute();
      for (const competitor of competitors) {
        const item = byTarget.get(competitor.domain);
        const organic = item?.metrics?.organic ?? { etv: 0, count: 0 };
        const paid = item?.metrics?.paid ?? { etv: 0, count: 0 };
        const domainDetails = details.get(competitor.domain) ?? {};
        const competitorKeywords = Array.isArray(domainDetails['topKeywords']) ? domainDetails['topKeywords'] : [];
        const brandTokens = competitor.domain.split('.')[0].split(/[-_]/).filter((token) => token.length >= 4);
        const opportunities = competitorKeywords.filter((row) => { const keyword=String(this.object(row)['keyword']??'').toLowerCase(); return !targetKeywordSet.has(keyword) && !brandTokens.some((token)=>keyword.includes(token)); }).slice(0, 8);
        const previous = this.object(competitor.metrics); const previousHistory = Array.isArray(previous['history']) ? previous['history'] : [];
        const snapshot = { checkedAt: checkedAt.toISOString(), organicTraffic: Number(organic?.etv ?? 0), rankingKeywords: Number(organic?.count ?? 0), visibilityShare: totalTraffic > 0 ? Number(organic?.etv ?? 0) / totalTraffic : 0, targetOrganicTraffic: Number(targetItem?.metrics?.organic?.etv ?? 0), targetRankingKeywords: Number(targetItem?.metrics?.organic?.count ?? 0), targetVisibilityShare: totalTraffic > 0 ? Number(targetItem?.metrics?.organic?.etv ?? 0) / totalTraffic : 0 };
        const history = [...previousHistory, snapshot].slice(-12);
        await trx.updateTable('capere.competitors').set({ metrics: JSON.stringify({ status: item ? 'ready' : 'no_data', organicTraffic: Number(organic?.etv ?? 0), rankingKeywords: Number(organic?.count ?? 0), visibilityShare: snapshot.visibilityShare, paidTraffic: Number(paid?.etv ?? 0), paidKeywords: Number(paid?.count ?? 0), top3: Number(domainDetails['top3'] ?? 0), top10: Number(domainDetails['top10'] ?? 0), trafficValue: Number(domainDetails['trafficValue'] ?? 0), newKeywords: Number(domainDetails['newKeywords'] ?? 0), improvedKeywords: Number(domainDetails['improvedKeywords'] ?? 0), declinedKeywords: Number(domainDetails['declinedKeywords'] ?? 0), topKeywords: competitorKeywords, keywordOpportunities: opportunities, sharedKeywordCount: competitorKeywords.length - opportunities.length, topPages: domainDetails['topPages'] ?? [], history, targetOrganicTraffic: Number(targetItem?.metrics?.organic?.etv ?? 0), targetRankingKeywords: Number(targetItem?.metrics?.organic?.count ?? 0), targetVisibilityShare: totalTraffic > 0 ? Number(targetItem?.metrics?.organic?.etv ?? 0) / totalTraffic : 0, targetTop3: Number(targetDetails['top3'] ?? 0), targetTop10: Number(targetDetails['top10'] ?? 0), targetTrafficValue: Number(targetDetails['trafficValue'] ?? 0), targetTopKeywords: targetDetails['topKeywords'] ?? [], targetTopPages: targetDetails['topPages'] ?? [], locationCode: project.target_location_code, languageCode: project.language_code }), last_checked_at: checkedAt, updated_at: checkedAt }).where('organization_id','=',organizationId).where('id','=',competitor.id).execute();
      }
    });
    return { refreshed: competitors.length, cost: Number(task?.cost ?? 0) + detailCost, checkedAt: checkedAt.toISOString() };
  }

  async refreshKeywords(organizationId: string, projectId: string) {
    const project = await this.database.db.selectFrom('capere.seo_projects').selectAll().where('organization_id','=',organizationId).where('id','=',projectId).executeTakeFirst();
    if (!project) throw AppException.notFound(ErrorCode.NOT_FOUND, 'SEO project not found');
    const recent = await this.database.db.selectFrom('capere.provider_tasks').select('updated_at').where('organization_id','=',organizationId).where('provider','=','data_for_seo').where('task_type','=','keyword_overview').orderBy('updated_at','desc').executeTakeFirst();
    if (recent && new Date(recent.updated_at).getTime() >= Date.now() - 6 * 3_600_000) return { refreshed:0,cached:true,message:'Keyword data is already current.' };
    const start = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0,10);
    const [gscRows, competitors] = await Promise.all([
      this.database.db.selectFrom('capere.analytics_daily').select(['dimensions','metrics']).where('organization_id','=',organizationId).where('provider','=','google_search_console').where('metric_date','>=',start).execute(),
      this.database.db.selectFrom('capere.competitors').select(['metrics']).where('organization_id','=',organizationId).where('seo_project_id','=',projectId).execute(),
    ]);
    const gsc = new Map<string,{clicks:number;impressions:number;weightedPosition:number}>();
    for (const row of gscRows) { const dimensions=this.object(row.dimensions); const keyword=typeof dimensions['query']==='string'?dimensions['query'].trim().toLowerCase():''; if(!keyword)continue; const metrics=this.object(row.metrics); const impressions=Number(metrics['impressions']??0); const current=gsc.get(keyword)??{clicks:0,impressions:0,weightedPosition:0}; current.clicks+=Number(metrics['clicks']??0); current.impressions+=impressions; current.weightedPosition+=Number(metrics['position']??0)*Math.max(impressions,1); gsc.set(keyword,current); }
    const competitorTerms: Array<{keyword:string;searchVolume:number}> = [];
    for (const competitor of competitors) { const metrics=this.object(competitor.metrics); const rows=Array.isArray(metrics['keywordOpportunities'])?metrics['keywordOpportunities']:[]; for(const raw of rows){const row=this.object(raw);const keyword=String(row['keyword']??'').trim().toLowerCase();if(keyword)competitorTerms.push({keyword,searchVolume:Number(row['searchVolume']??0)});} }
    const gscCandidates=[...gsc.entries()].sort((a,b)=>b[1].impressions-a[1].impressions).map(([keyword])=>keyword);
    const candidates=[...new Set([...gscCandidates,...competitorTerms.sort((a,b)=>b.searchVolume-a.searchVolume).map((row)=>row.keyword)])].slice(0,20);
    if(!candidates.length)return {refreshed:0,message:'No Search Console queries or competitor opportunities are available yet.'};
    const request={keywords:candidates,location_code:project.target_location_code,language_code:project.language_code};
    const integration=await this.ensurePlatformIntegration(organizationId);
    const response=await this.adapter.postTask<Record<string,unknown>>('dataforseo_labs/google/keyword_overview/live',request);
    const task=response.tasks?.[0]; const root=this.object(task?.result?.[0]); const items=Array.isArray(root['items'])?root['items']:[];
    const checkedOn=new Date().toISOString().slice(0,10); const fingerprint=createHash('sha256').update(JSON.stringify(request)).digest('hex');
    await this.database.transaction(async(trx)=>{
      await trx.insertInto('capere.provider_tasks').values({organization_id:organizationId,integration_id:integration.id,provider:'data_for_seo',task_type:'keyword_overview',request_fingerprint:fingerprint,provider_task_id:task?.id??null,status:'succeeded',request:JSON.stringify(request),result:JSON.stringify(root),cost_micro_usd:String(Math.round(Number(task?.cost??0)*1_000_000)),attempts:1,next_poll_at:null,error:null}).onConflict((oc)=>oc.columns(['organization_id','provider','task_type','request_fingerprint']).doUpdateSet({result:JSON.stringify(root),status:'succeeded',cost_micro_usd:String(Math.round(Number(task?.cost??0)*1_000_000)),updated_at:new Date()})).execute();
      await trx.updateTable('capere.keywords').set({enabled:false,updated_at:new Date()}).where('organization_id','=',organizationId).where('seo_project_id','=',projectId).where(sql<boolean>`tags @> ARRAY['competitor_opportunity']::text[]`).execute();
      for(const raw of items){const item=this.object(raw);const keyword=String(item['keyword']??'').trim().toLowerCase();if(!keyword)continue;const info=this.object(item['keyword_info']);const properties=this.object(item['keyword_properties']);const intent=this.object(item['search_intent_info']);const observed=gsc.get(keyword);const position=observed?observed.weightedPosition/Math.max(observed.impressions,1):null;const source=observed?'search_console':'competitor_opportunity';const category=position===null?'opportunity':position<=10?'performing':position<=20?'close_to_page_one':'needs_improvement';const summary={source,category,searchVolume:Number(info['search_volume']??0),difficulty:Number(properties['keyword_difficulty']??0),intent:String(intent['main_intent']??'unknown'),competition:String(info['competition_level']??'unknown').toLowerCase(),clicks:observed?.clicks??0,impressions:observed?.impressions??0,position,monthlyTrend:Number(this.object(info['search_volume_trend'])['monthly']??0)};const keywordRow=await trx.insertInto('capere.keywords').values({organization_id:organizationId,seo_project_id:projectId,keyword,tags:[source,category],enabled:true}).onConflict((oc)=>oc.columns(['organization_id','seo_project_id','keyword']).doUpdateSet({tags:[source,category],enabled:true,updated_at:new Date()})).returning('id').executeTakeFirstOrThrow();await trx.insertInto('capere.keyword_rankings').values({organization_id:organizationId,keyword_id:keywordRow.id,checked_on:checkedOn,rank:position?Math.round(position):null,url:null,serp_features:JSON.stringify([]),raw_summary:JSON.stringify(summary)}).onConflict((oc)=>oc.columns(['organization_id','keyword_id','checked_on']).doUpdateSet({rank:position?Math.round(position):null,raw_summary:JSON.stringify(summary)})).execute();}
    });
    return {refreshed:items.length,cost:Number(task?.cost??0),checkedAt:checkedOn};
  }

  async removeCompetitor(organizationId: string, projectId: string, competitorId: string) {
    const deleted = await this.database.db.deleteFrom('capere.competitors').where('organization_id','=',organizationId).where('seo_project_id','=',projectId).where('id','=',competitorId).returning('id').executeTakeFirst();
    if (!deleted) throw AppException.notFound(ErrorCode.NOT_FOUND, 'Competitor not found');
    return { deleted: true, id: deleted.id };
  }

  async createProject(organizationId: string, dto: CreateSeoProjectDto) {
    const url = new URL(dto.siteUrl);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    const sharedHosts = ['vercel.app', 'netlify.app', 'pages.dev', 'github.io'];
    if (sharedHosts.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
      throw AppException.badRequest(ErrorCode.BAD_REQUEST, 'Please use a verified custom domain');
    }
    try {
      let response = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(5000) });
      if (response.status === 405) {
        response = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(5000), headers: { range: 'bytes=0-1023' } });
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      throw AppException.badRequest(ErrorCode.BAD_REQUEST, 'Website is not reachable; verify the URL and try again');
    }
    await this.ensurePlatformIntegration(organizationId);
    const project = await this.database.db
      .insertInto('capere.seo_projects')
      .values({
        organization_id: organizationId,
        name: dto.name,
        site_url: url.toString().replace(/\/$/, ''),
        target_location_code: dto.targetLocationCode,
        language_code: dto.languageCode,
        enabled: true,
      })
      .onConflict((c) =>
        c.columns(['organization_id', 'site_url']).doUpdateSet({
          name: dto.name,
          target_location_code: dto.targetLocationCode,
          language_code: dto.languageCode,
          enabled: true,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.database.db
      .insertInto('capere.scheduled_jobs')
      .values({
        organization_id: organizationId,
        job_type: 'dataforseo-audit-submit',
        name: `dataforseo-audit:${project.id}`,
        schedule: 'weekly',
        enabled: true,
        next_run_at: new Date(),
        payload: JSON.stringify({ projectId: project.id, maxCrawlPages: 20 }),
      })
      .onConflict((c) => c.columns(['organization_id', 'name']).doUpdateSet({
        enabled: true,
        next_run_at: new Date(),
        payload: JSON.stringify({ projectId: project.id, maxCrawlPages: 20 }),
      }))
      .execute();
    await this.database.db.insertInto('capere.scheduled_jobs').values({ organization_id:organizationId,job_type:'dataforseo-keyword-refresh',name:`dataforseo-keywords:${project.id}`,schedule:'weekly',enabled:true,next_run_at:new Date(Date.now()+15*60_000),payload:JSON.stringify({projectId:project.id}) }).onConflict((oc)=>oc.columns(['organization_id','name']).doUpdateSet({enabled:true,payload:JSON.stringify({projectId:project.id})})).execute();
    return project;
  }

  async submitAudit(organizationId: string, projectId: string, dto: RunSeoAuditDto) {
    const project = await this.database.db
      .selectFrom('capere.seo_projects')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', projectId)
      .executeTakeFirst();
    if (!project) throw AppException.notFound(ErrorCode.NOT_FOUND, 'SEO project not found');
    const integration = await this.ensurePlatformIntegration(organizationId);
    const request = {
      target: new URL(project.site_url).hostname,
      max_crawl_pages: Math.min(dto.maxCrawlPages || 20, 20),
      enable_javascript: false,
      pingback_url: this.config.dataForSeo.pingbackUrl || undefined,
      tag: `capere:${organizationId}:${project.id}`,
    };
    const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    return this.database.transaction(async (trx) => {
      // The external task is billable. Serialize identical submissions before
      // checking and calling the provider so concurrent HTTP requests cannot
      // purchase two audits and only discover the conflict at the local unique
      // constraint afterward.
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`dataforseo:${organizationId}:${fingerprint}`}, 0))`.execute(
        trx,
      );
      const existing = await trx
        .selectFrom('capere.provider_tasks')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('provider', '=', 'data_for_seo')
        .where('task_type', '=', 'on_page_audit')
        .where('request_fingerprint', '=', fingerprint)
        .executeTakeFirst();
      if (existing) return existing;
      const response = await this.adapter.postTask('on_page/task_post', request);
      const providerTask = response.tasks?.[0];
      if (!providerTask?.id)
        throw AppException.serviceUnavailable(
          ErrorCode.INTEGRATION_ERROR,
          'DataForSEO did not accept the audit',
        );
      const task = await trx
        .insertInto('capere.provider_tasks')
        .values({
          organization_id: organizationId,
          integration_id: integration.id,
          provider: 'data_for_seo',
          task_type: 'on_page_audit',
          request_fingerprint: fingerprint,
          provider_task_id: providerTask.id,
          status: 'polling',
          request: JSON.stringify(request),
          result: null,
          cost_micro_usd: String(Math.round((providerTask.cost ?? 0) * 1_000_000)),
          attempts: 1,
          next_poll_at: new Date(Date.now() + 60_000),
          error: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('capere.technical_audits')
        .values({
          organization_id: organizationId,
          seo_project_id: project.id,
          provider_task_id: task.id,
          status: 'polling',
          score: null,
          issue_count: null,
          summary: JSON.stringify({}),
          completed_at: null,
        })
        .execute();
      await trx
        .insertInto('capere.scheduled_jobs')
        .values({
          organization_id: organizationId,
          job_type: 'dataforseo-audit-poll',
          name: `dataforseo-audit-poll:${task.id}`,
          schedule: 'hourly',
          enabled: true,
          next_run_at: new Date(Date.now() + 60_000),
          payload: JSON.stringify({ taskId: task.id }),
        })
        .execute();
      return task;
    });
  }

  async pollAudit(organizationId: string, taskId: string) {
    const task = await this.database.db
      .selectFrom('capere.provider_tasks')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', taskId)
      .executeTakeFirst();
    if (!task?.provider_task_id)
      throw AppException.notFound(ErrorCode.NOT_FOUND, 'Provider task not found');
    const response = await this.adapter.postTask<Record<string, unknown>>('on_page/summary', {
      id: task.provider_task_id,
    });
    const providerTask = response.tasks?.[0];
    const result = providerTask?.result?.[0];
    if (!result) return { ready: false };
    const audit = await this.database.db
      .selectFrom('capere.technical_audits as a')
      .innerJoin('capere.seo_projects as p', 'p.id', 'a.seo_project_id')
      .select(['a.id', 'a.seo_project_id', 'p.site_url'])
      .where('a.organization_id', '=', organizationId)
      .where('a.provider_task_id', '=', task.id)
      .executeTakeFirstOrThrow();
    const score = this.score(result);
    const issueCount = this.issueCount(result);
    await this.database.transaction(async (trx) => {
      await trx
        .updateTable('capere.provider_tasks')
        .set({
          status: 'succeeded',
          result: JSON.stringify(result),
          next_poll_at: null,
          error: null,
        })
        .where('id', '=', task.id)
        .execute();
      await trx
        .updateTable('capere.technical_audits')
        .set({
          status: 'succeeded',
          score,
          issue_count: issueCount,
          summary: JSON.stringify(result),
          completed_at: new Date(),
        })
        .where('id', '=', audit.id)
        .execute();
      await trx
        .updateTable('capere.integrations')
        .set({ last_sync_at: new Date(), last_error: null })
        .where('id', '=', task.integration_id!)
        .execute();
      await trx
        .updateTable('capere.scheduled_jobs')
        .set({ enabled: false })
        .where('organization_id', '=', organizationId)
        .where('name', '=', `dataforseo-audit-poll:${task.id}`)
        .execute();
      await this.outbox.publishInTransaction(trx, {
        type: EventType.SeoAuditCompleted,
        organizationId,
        aggregateType: 'technical_audit',
        aggregateId: audit.id,
        payload: { auditId: audit.id, siteUrl: audit.site_url, score, issueCount },
      });
    });
    return { ready: true, auditId: audit.id, score, issueCount };
  }

  async handleWebhook(body: unknown) {
    const payload = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    const task = payload['id'] ?? payload['task_id'];
    if (typeof task !== 'string') return { accepted: true };
    const row = await this.database.db.selectFrom('capere.provider_tasks').select(['organization_id', 'id']).where('provider', '=', 'data_for_seo').where('provider_task_id', '=', task).executeTakeFirst();
    if (!row) return { accepted: true };
    return this.pollAudit(row.organization_id, row.id);
  }

  private score(result: Record<string, unknown>): number {
    const pageMetrics = this.object(result['page_metrics']);
    const value = Number(pageMetrics['onpage_score'] ?? result['onpage_score'] ?? result['score'] ?? 0);
    return Math.max(0, Math.min(100, Math.round(value)));
  }
  private issueCount(result: Record<string, unknown>): number {
    const pageMetrics = this.object(result['page_metrics']);
    const checks = this.object(pageMetrics['checks']);
    const healthySignals = new Set([
      'is_https',
      'canonical',
      'has_html_doctype',
      'seo_friendly_url',
      'seo_friendly_url_dynamic_check',
      'seo_friendly_url_keywords_check',
      'seo_friendly_url_characters_check',
      'seo_friendly_url_relative_length_check',
    ]);
    const pageIssues = Object.entries(checks).reduce((total, [key, value]) => {
      if (healthySignals.has(key)) return total;
      const count = Number(value);
      return total + (Number.isFinite(count) && count > 0 ? count : 0);
    }, 0);
    const domainChecks = this.object(this.object(result['domain_info'])['checks']);
    const missingDomainFiles = ['sitemap', 'robots_txt'].filter((key) => domainChecks[key] === false).length;
    return pageIssues + missingDomainFiles || Number(result['total_issues'] ?? 0);
  }

  private object(value: unknown): Record<string, unknown> {
    if (typeof value === 'string') { try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; } }
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }
}
