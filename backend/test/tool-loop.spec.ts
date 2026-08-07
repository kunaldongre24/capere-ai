import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ToolExecutionService } from '../src/intelligence/execution/tool-execution.service';
import { GetGa4SummaryTool } from '../src/intelligence/tools/get-ga4-summary.tool';
import { GetGbpSummaryTool } from '../src/intelligence/tools/get-gbp-summary.tool';
import { GetGscSummaryTool } from '../src/intelligence/tools/get-gsc-summary.tool';
import { GetGhlPipelineSummaryTool } from '../src/intelligence/tools/get-ghl-pipeline-summary.tool';
import { GetSeoProjectSummaryTool } from '../src/intelligence/tools/get-seo-project-summary.tool';
import { ToolRegistry } from '../src/intelligence/tools/tool-registry';
import type { GhlTokenService } from '../src/integrations/ghl/ghl-token.service';
import type { GhlAdapter } from '../src/integrations/ghl/ghl.adapter';
import type { ModelRouterService } from '../src/llm';
import type { DatabaseService } from '../src/shared/database';
import {
  cleanup,
  closeDb,
  seedTwoOrganizations,
  serviceDb,
  type Fixture,
} from './helpers/database';

describe('stateless intelligence tool loop', () => {
  let fixture: Fixture;
  const integrationIds: string[] = [];
  let seoProjectId: string;
  let ghlIntegrationId: string;

  beforeAll(async () => {
    fixture = await seedTwoOrganizations();
    const integration = await serviceDb()
      .insertInto('capere.integrations')
      .values({
        organization_id: fixture.orgAId,
        provider: 'google_analytics_4',
        account_id: 'properties/tool-loop',
        account_name: 'Tool loop GA4',
        status: 'connected',
        scopes: 'read',
        sync_enabled: true,
        last_sync_at: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    integrationIds.push(integration.id);
    const gsc = await serviceDb()
      .insertInto('capere.integrations')
      .values({
        organization_id: fixture.orgAId,
        provider: 'google_search_console',
        account_id: 'https://example.com/',
        status: 'connected',
        scopes: 'read',
        sync_enabled: true,
        last_sync_at: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const gbp = await serviceDb()
      .insertInto('capere.integrations')
      .values({
        organization_id: fixture.orgAId,
        provider: 'google_business_profile',
        account_id: 'locations/123',
        status: 'connected',
        scopes: 'read',
        sync_enabled: true,
        last_sync_at: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    integrationIds.push(gsc.id, gbp.id);
    const ghl = await serviceDb()
      .insertInto('capere.integrations')
      .values({
        organization_id: fixture.orgAId,
        provider: 'go_high_level',
        account_id: 'location/tool-loop',
        account_name: 'Tool loop location',
        status: 'connected',
        scopes: 'read',
        sync_enabled: true,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    ghlIntegrationId = ghl.id;
    integrationIds.push(ghl.id);

    const project = await serviceDb()
      .insertInto('capere.seo_projects')
      .values({
        organization_id: fixture.orgAId,
        name: 'Tool loop SEO',
        site_url: 'https://tool-loop.example',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    seoProjectId = project.id;
    const keyword = await serviceDb()
      .insertInto('capere.keywords')
      .values({
        organization_id: fixture.orgAId,
        seo_project_id: project.id,
        keyword: 'cpa firm near me',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await serviceDb()
      .insertInto('capere.keyword_rankings')
      .values([
        {
          organization_id: fixture.orgAId,
          keyword_id: keyword.id,
          checked_on: '2026-08-01',
          rank: 12,
        },
        {
          organization_id: fixture.orgAId,
          keyword_id: keyword.id,
          checked_on: '2026-08-03',
          rank: 4,
        },
      ])
      .execute();
    await serviceDb()
      .insertInto('capere.technical_audits')
      .values({
        organization_id: fixture.orgAId,
        seo_project_id: project.id,
        status: 'succeeded',
        score: 88,
        issue_count: 3,
        summary: JSON.stringify({
          onpage_score: 88,
          nested: { huge: true },
          note: 'x'.repeat(700),
        }),
        completed_at: new Date('2026-08-03T00:00:00.000Z'),
      })
      .execute();

    const now = new Date();
    const latest = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 86_400_000,
    );
    for (let offset = 13; offset >= 0; offset -= 1) {
      const date = new Date(latest.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
      const current = offset <= 6;
      await serviceDb()
        .insertInto('capere.analytics_daily')
        .values({
          organization_id: fixture.orgAId,
          integration_id: integration.id,
          provider: 'google_analytics_4',
          resource_id: 'properties/tool-loop',
          metric_date: date,
          metrics: JSON.stringify({
            sessions: current ? 100 : 50,
            activeUsers: current ? 80 : 40,
            conversions: current ? 10 : 5,
            revenue: current ? 1000 : 500,
          }),
        })
        .execute();
      await serviceDb()
        .insertInto('capere.analytics_daily')
        .values({
          organization_id: fixture.orgAId,
          integration_id: gsc.id,
          provider: 'google_search_console',
          resource_id: 'https://example.com/',
          metric_date: date,
          dimensions: JSON.stringify({}),
          metrics: JSON.stringify({
            clicks: current ? 20 : 10,
            impressions: current ? 200 : 100,
            ctr: 0.1,
            position: current ? 4 : 6,
          }),
        })
        .execute();
      await serviceDb()
        .insertInto('capere.analytics_daily')
        .values({
          organization_id: fixture.orgAId,
          integration_id: gbp.id,
          provider: 'google_business_profile',
          resource_id: 'locations/123',
          metric_date: date,
          metrics: JSON.stringify({
            WEBSITE_CLICKS: current ? 8 : 4,
            CALL_CLICKS: current ? 3 : 1,
            BUSINESS_DIRECTION_REQUESTS: current ? 2 : 1,
          }),
        })
        .execute();
    }
    await serviceDb()
      .insertInto('capere.integration_sync_states')
      .values({
        organization_id: fixture.orgAId,
        integration_id: integration.id,
        dataset: 'ga4_daily',
        status: 'succeeded',
        cursor: JSON.stringify({
          periodStart: new Date(latest.getTime() - 6 * 86_400_000).toISOString().slice(0, 10),
          periodEnd: latest.toISOString().slice(0, 10),
          rowCount: 7,
          providerCompletedAt: new Date().toISOString(),
        }),
        last_succeeded_at: new Date(),
      })
      .execute();
    await serviceDb()
      .insertInto('capere.gbp_reviews')
      .values({
        organization_id: fixture.orgAId,
        integration_id: gbp.id,
        location_id: 'locations/123',
        review_id: 'review/tool-loop',
        rating: 5,
        comment: 'Excellent',
        reviewer_name: 'Test User',
      })
      .execute();
  });

  afterAll(async () => {
    await serviceDb()
      .deleteFrom('capere.analytics_daily')
      .where('integration_id', 'in', integrationIds)
      .execute();
    await cleanup(fixture);
    await closeDb();
  });

  it('executes a model-selected GA4 tool and feeds grounded output into the final turn', async () => {
    const registry = new ToolRegistry();
    const database = { db: serviceDb() } as unknown as DatabaseService;
    new GetGa4SummaryTool(database, registry).onModuleInit();
    new GetGscSummaryTool(database, registry).onModuleInit();
    new GetGbpSummaryTool(database, registry).onModuleInit();

    const complete = vi
      .fn()
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          { id: 'call_ga4', name: 'get_ga4_summary', arguments: JSON.stringify({ days: 7 }) },
          { id: 'call_gsc', name: 'get_gsc_summary', arguments: JSON.stringify({ days: 7 }) },
          { id: 'call_gbp', name: 'get_gbp_summary', arguments: JSON.stringify({ days: 7 }) },
        ],
      })
      .mockResolvedValueOnce({ content: 'Sessions doubled to 700.', toolCalls: [] });
    const execution = new ToolExecutionService(
      { complete } as unknown as ModelRouterService,
      registry,
    );

    const result = await execution.run({
      organizationId: fixture.orgAId,
      role: 'owner',
      agent: 'general',
      systemPrompt: 'Use tools for real metrics.',
      messages: [{ role: 'user', content: 'How did website traffic change?' }],
      allowMutatingTools: false,
    });

    expect(registry.names()).toEqual(['get_ga4_summary', 'get_gbp_summary', 'get_gsc_summary']);
    const ga4Descriptor = registry
      .descriptorsFor('office_manager', { agent: 'analytics' })
      .find((descriptor) => descriptor.name === 'get_ga4_summary');
    expect(ga4Descriptor?.parameters).not.toHaveProperty('properties.integrationId');
    expect(ga4Descriptor?.parameters).toHaveProperty('properties.property');
    const solePropertyFallback = await registry.execute(
      'get_ga4_summary',
      JSON.stringify({ property: 'google_analytics_4', days: 7 }),
      {
        organizationId: fixture.orgAId,
        role: 'owner',
        agent: 'analytics',
        signal: new AbortController().signal,
      },
    );
    expect(solePropertyFallback).toMatchObject({
      ok: true,
      output: { connected: true, dataAvailable: true },
    });
    expect(JSON.stringify(solePropertyFallback)).not.toContain(integrationIds[0]);
    const unmatchedProperty = await registry.execute(
      'get_ga4_summary',
      JSON.stringify({ property: 'unrelated-property', days: 7 }),
      {
        organizationId: fixture.orgAId,
        role: 'owner',
        agent: 'analytics',
        signal: new AbortController().signal,
      },
    );
    expect(unmatchedProperty).toMatchObject({
      ok: true,
      output: {
        connected: true,
        dataAvailable: false,
        availableResources: [{ resourceId: 'properties/tool-loop', name: 'Tool loop GA4' }],
      },
    });
    expect(result.content).toBe('Sessions doubled to 700.');
    expect(result.toolResults).toHaveLength(3);
    expect(result.toolResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolName: 'get_ga4_summary', ok: true }),
        expect.objectContaining({ toolName: 'get_gsc_summary', ok: true }),
        expect.objectContaining({ toolName: 'get_gbp_summary', ok: true }),
      ]),
    );
    const secondRequest = complete.mock.calls[1][0] as {
      messages: Array<{ role: string; content: string; name?: string }>;
    };
    const toolMessage = secondRequest.messages.find((message) => message.role === 'tool');
    expect(toolMessage?.content).toContain('"sessions":700');
    expect(toolMessage?.content).toContain('"sessions":350');
    expect(toolMessage?.content).toContain('"sessions":100');
    expect(
      secondRequest.messages.find((message) => message.name === 'get_gsc_summary')?.content,
    ).toContain('"clicks":140');
    expect(
      secondRequest.messages.find((message) => message.name === 'get_gbp_summary')?.content,
    ).toContain('"CALL_CLICKS":21');

    await serviceDb()
      .deleteFrom('capere.analytics_daily')
      .where('integration_id', '=', integrationIds[0])
      .execute();
    await serviceDb()
      .insertInto('capere.analytics_daily')
      .values({
        organization_id: fixture.orgAId,
        integration_id: integrationIds[0],
        provider: 'google_analytics_4',
        resource_id: 'properties/tool-loop',
        metric_date: '2020-01-01',
        metrics: JSON.stringify({ sessions: 999 }),
      })
      .execute();
    const stale = await registry.execute('get_ga4_summary', JSON.stringify({ days: 7 }), {
      organizationId: fixture.orgAId,
      role: 'owner',
      agent: 'analytics',
      signal: new AbortController().signal,
    });
    expect(stale).toMatchObject({
      ok: true,
      output: {
        connected: true,
        dataAvailable: false,
        latestAvailableDate: '2020-01-01',
        syncCoverage: expect.objectContaining({ rowCount: 7 }),
      },
    });
    expect(JSON.stringify(stale)).not.toContain(integrationIds[0]);
    expect(JSON.stringify(stale)).toContain('cannot be inferred from stale data');
  });

  it('runs the SEO specialist through a real bounded project tool', async () => {
    const registry = new ToolRegistry();
    const database = { db: serviceDb() } as unknown as DatabaseService;
    new GetSeoProjectSummaryTool(database, registry).onModuleInit();
    const complete = vi
      .fn()
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          {
            id: 'call_seo',
            name: 'get_seo_project_summary',
            arguments: JSON.stringify({ projectId: seoProjectId }),
          },
        ],
      })
      .mockResolvedValueOnce({ content: 'The latest tracked rank is 4.', toolCalls: [] });
    const execution = new ToolExecutionService(
      { complete } as unknown as ModelRouterService,
      registry,
    );

    const result = await execution.run({
      organizationId: fixture.orgAId,
      role: 'owner',
      agent: 'seo',
      systemPrompt: 'Use SEO evidence.',
      messages: [{ role: 'user', content: 'How are our rankings?' }],
      allowMutatingTools: false,
    });

    expect(result.content).toBe('The latest tracked rank is 4.');
    expect(result.toolResults[0]).toMatchObject({ toolName: 'get_seo_project_summary', ok: true });
    const secondRequest = complete.mock.calls[1][0] as {
      messages: Array<{ role: string; content: string; name?: string }>;
    };
    const evidence = secondRequest.messages.find(
      (message) => message.name === 'get_seo_project_summary',
    )?.content;
    expect(evidence).toContain('"rank":4');
    expect(evidence).not.toContain('"rank":12');
    expect(evidence).not.toContain('"nested"');
    expect(evidence).not.toContain('x'.repeat(501));
  });

  it('paginates GHL opportunities and marks capped results incomplete', async () => {
    const registry = new ToolRegistry();
    const database = { db: serviceDb() } as unknown as DatabaseService;
    const vault = {
      credentials: vi.fn().mockResolvedValue({ accessToken: 'secret' }),
    } as unknown as GhlTokenService;
    const getJson = vi
      .fn()
      .mockResolvedValueOnce({
        opportunities: Array.from({ length: 100 }, (_, index) => ({
          id: `a-${index}`,
          status: 'open',
          pipelineId: 'pipeline-a',
          monetaryValue: 10,
        })),
        meta: { total: 250, currentPage: 1, nextPage: 2 },
      })
      .mockResolvedValueOnce({
        opportunities: Array.from({ length: 50 }, (_, index) => ({
          id: `b-${index}`,
          status: 'won',
          pipelineId: 'pipeline-a',
          monetaryValue: 20,
        })),
        meta: { total: 250, currentPage: 2, nextPage: 3 },
      });
    const ghl = { getJson } as unknown as GhlAdapter;
    const tool = new GetGhlPipelineSummaryTool(database, vault, ghl, registry);

    const output = (await tool.execute(
      { integrationId: ghlIntegrationId, maxRecords: 150 },
      {
        organizationId: fixture.orgAId,
        role: 'owner',
        agent: 'cmo',
        signal: new AbortController().signal,
      },
    )) as Record<string, unknown>;

    expect(getJson).toHaveBeenCalledTimes(2);
    expect(output).toMatchObject({
      returned: 150,
      total: 250,
      pipelineValue: 2000,
      complete: false,
      truncated: true,
      pagesRead: 2,
      byStatus: { open: 100, won: 50 },
    });
  });
});
