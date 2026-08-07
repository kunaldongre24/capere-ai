import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { ModelRouterService } from '../llm';
import { DatabaseService } from '../shared/database';
import { DashboardService } from './dashboard.service';

@Injectable()
export class ContentGenerationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly dashboards: DashboardService,
    private readonly models: ModelRouterService,
  ) {}

  async generate(
    organizationId: string,
    request = 'Create a concise Google Business Profile post highlighting a useful CPA service.',
  ) {
    const day = new Date().toISOString().slice(0, 10);
    const title = request.slice(0, 120);
    return this.database.transaction(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`content:${organizationId}:${day}:${title}`}, 0))`.execute(
        trx,
      );
      const existing = await trx
        .selectFrom('capere.generated_artifacts')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('kind', '=', 'content_draft')
        .where('artifact_date', '=', day)
        .where('title', '=', title)
        .executeTakeFirst();
      if (existing) return existing;

      const evidence = await this.dashboards.cmoBrief(organizationId);
      const completion = await this.models.complete(
        {
          messages: [
            {
              role: 'system',
              content:
                'You produce factual CPA marketing drafts. Never invent credentials, laws, testimonials, dates, rankings, or local facts. Return publication-ready text only.',
            },
            {
              role: 'user',
              content: `${request}\nEvidence (may be empty): ${JSON.stringify(evidence).slice(0, 8000)}`,
            },
          ],
          responseFormat: { type: 'text' },
          maxTokens: 800,
        },
        {
          organizationId,
          agent: 'content',
          taskType: 'cheap',
          metadata: { phase: 'content-generator' },
        },
      );
      return trx
        .insertInto('capere.generated_artifacts')
        .values({
          organization_id: organizationId,
          kind: 'content_draft',
          artifact_date: day,
          title,
          content: completion.content,
          evidence: JSON.stringify({
            model: completion.servedModel,
            metricCount: evidence.metrics.length,
          }),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }
}
