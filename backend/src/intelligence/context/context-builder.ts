import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../shared/database';
import type { MemorySnapshot } from '../memory/memory.interface';

export interface OrganizationContext {
  readonly organizationId: string;
  readonly organizationName: string;
  /** GHL locations this organization owns — references only, never CRM data. */
  readonly ghlLocations: Array<{ id: string; ghlLocationId: string; name?: string }>;
  readonly integrations: Array<{
    provider: string;
    status: string;
    lastSyncAt?: Date;
  }>;
  readonly activeInsights: Array<{
    category: string;
    severity: string;
    title: string;
    body: string;
  }>;
}

/**
 * Assembles current organization context for one stateless request.
 *
 * Separate from memory on purpose: memory is what the assistant REMEMBERS
 * (conversation, learned facts, retrieved documents), while this is what is
 * CURRENTLY TRUE about the account (which integrations are connected, which
 * insights are open). The first is historical, the second is live state that
 * must be re-read every run.
 */
@Injectable()
export class ContextBuilder {
  constructor(private readonly database: DatabaseService) {}

  async forOrganization(organizationId: string): Promise<OrganizationContext> {
    const [organization, locations, integrations, insights] = await Promise.all([
      this.database.db
        .selectFrom('capere.organizations')
        .select(['id', 'name'])
        .where('id', '=', organizationId)
        .executeTakeFirst(),

      this.database.db
        .selectFrom('capere.ghl_locations')
        .select(['id', 'ghl_location_id', 'name'])
        .where('organization_id', '=', organizationId)
        .execute(),

      this.database.db
        .selectFrom('capere.integrations')
        .select(['provider', 'status', 'last_sync_at'])
        .where('organization_id', '=', organizationId)
        .execute(),

      // Only ACTIVE, unexpired insights. A stale or dismissed insight in the
      // prompt would have the model advising on a problem already solved.
      this.database.db
        .selectFrom('capere.insights')
        .select(['category', 'severity', 'title', 'body'])
        .where('organization_id', '=', organizationId)
        .where('status', '=', 'active')
        .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', new Date())]))
        .orderBy('created_at', 'desc')
        .limit(10)
        .execute(),
    ]);

    return {
      organizationId,
      organizationName: organization?.name ?? 'Unknown organization',
      ghlLocations: locations.map((l) => ({
        id: l.id,
        ghlLocationId: l.ghl_location_id,
        name: l.name ?? undefined,
      })),
      integrations: integrations.map((i) => ({
        provider: i.provider,
        status: i.status,
        lastSyncAt: i.last_sync_at ?? undefined,
      })),
      activeInsights: insights.map((i) => ({
        category: i.category,
        severity: i.severity,
        title: i.title,
        body: i.body,
      })),
    };
  }

  /**
   * Renders context and memory as the text block appended to the system prompt.
   *
   * Two deliberate choices here:
   *
   * 1. **Disconnected integrations are listed explicitly.** If GA4 is not
   *    connected, the model must know that, or it will answer traffic questions
   *    from imagination. Naming the gap is what lets it say "connect GA4 to get
   *    this" instead of inventing a number.
   *
   * 2. **Unavailable semantic memory is stated, not omitted.** A model that
   *    believes it searched the playbook and found nothing answers confidently
   *    from priors. One told the playbook was unavailable hedges appropriately.
   */
  render(context: OrganizationContext, memory: MemorySnapshot): string {
    const sections: string[] = [];

    sections.push(`## Organization\n${context.organizationName}`);

    if (context.ghlLocations.length > 0) {
      const locations = context.ghlLocations
        .map((l) => `- ${l.name ?? l.ghlLocationId} (GHL location ${l.ghlLocationId})`)
        .join('\n');
      sections.push(`## GoHighLevel locations\n${locations}`);
    }

    const connected = context.integrations.filter((i) => i.status === 'connected');
    const notConnected = context.integrations.filter((i) => i.status !== 'connected');

    const integrationLines: string[] = [];
    if (connected.length > 0) {
      integrationLines.push(
        'Connected: ' +
          connected
            .map(
              (i) =>
                `${i.provider}${i.lastSyncAt ? ` (synced ${i.lastSyncAt.toISOString().slice(0, 10)})` : ''}`,
            )
            .join(', '),
      );
    }
    if (connected.some((integration) => integration.provider === 'go_high_level')) {
      integrationLines.push(
        'GoHighLevel is Capere\'s source for CRM activity and Google review/reputation data. ' +
          'The absence of a separate google_business_profile integration does NOT mean review data is unavailable. ' +
          'Use get_gbp_summary to check review count, rating, and unanswered reviews. A direct Google Business Profile ' +
          'integration is only required for Google Maps/Search performance metrics such as profile impressions, calls, ' +
          'website clicks, and direction requests.',
      );
    }
    if (notConnected.length > 0) {
      integrationLines.push(
        'NOT connected: ' + notConnected.map((i) => `${i.provider} (${i.status})`).join(', '),
      );
    }
    if (integrationLines.length === 0) {
      integrationLines.push('No integrations have been connected yet.');
    }
    integrationLines.push(
      'Do not report metrics from a data source that is not connected. Check the appropriate tool before saying data is unavailable, because some capabilities are supplied through GoHighLevel rather than a separately named integration.',
    );
    sections.push(`## Data sources\n${integrationLines.join('\n')}`);

    if (memory.business.length > 0) {
      const facts = memory.business.map((f) => `- ${f.key}: ${JSON.stringify(f.value)}`).join('\n');
      sections.push(`## What we know about this firm\n${facts}`);
    }

    if (context.activeInsights.length > 0) {
      const insights = context.activeInsights
        .map((i) => `- [${i.severity}/${i.category}] ${i.title}: ${i.body}`)
        .join('\n');
      sections.push(`## Open insights\n${insights}`);
    }

    if (memory.semantic.length > 0) {
      const passages = memory.semantic
        .map(
          (hit, index) =>
            `[${index + 1}] ${hit.citation.title}` +
            `${hit.citation.section ? ` — ${hit.citation.section}` : ''}\n${hit.content}`,
        )
        .join('\n\n');
      sections.push(
        `## Reference material\nCite these by their bracketed number when you use them.\n\n${passages}`,
      );
    } else if (!memory.semanticAvailable) {
      sections.push(
        '## Reference material\nThe CPA playbook and SOP knowledge base is not available in ' +
          'this environment. Do not claim to have consulted it, and do not present ' +
          "general knowledge as if it came from the firm's documented procedures.",
      );
    }

    return sections.join('\n\n');
  }
}
