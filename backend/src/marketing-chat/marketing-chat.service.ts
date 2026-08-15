import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { GhlAdapter } from '../integrations/ghl/ghl.adapter';
import { GhlTokenService } from '../integrations/ghl/ghl-token.service';
import { ModelRouterService } from '../llm/router/model-router.service';
import { MemoryService } from '../intelligence/memory/memory.service';
import { APP_CONFIG, type AppConfig } from '../shared/config';
import { DatabaseService } from '../shared/database';
import { AppException, ErrorCode } from '../shared/http';
import type { MarketingChatRequestDto, MarketingLeadDto } from './marketing-chat.dto';

const SYSTEM_PROMPT = `You are the website assistant for Capere AI.
Capere AI is an AI Growth Operating System built specifically for CPA firms. It works with GoHighLevel to help firms improve search visibility, understand marketing and pipeline data, respond to inquiries, manage reviews, and turn more qualified prospects into booked consultations.

Your job is to help a CPA firm owner understand whether Capere is relevant and guide qualified visitors toward a CPA Growth Review.
- Be clear, concise, professional, and non-technical.
- Answer only from the product facts in this prompt. Do not invent customers, results, guarantees, integrations, certifications, or legal/tax claims.
- Explain that Capere complements GoHighLevel rather than replacing it.
- Current public pricing is a $997 implementation and $497 per month unless the visitor asks for a custom scope.
- Never give accounting, tax, legal, investment, or compliance advice.
- Ask at most one useful qualification question per response.
- Keep responses below 120 words and do not use markdown tables.
- When a visitor wants a demo, pricing discussion, or next step, tell them to use the Book a CPA Growth Review button.`;

@Injectable()
export class MarketingChatService {
  private readonly logger = new Logger(MarketingChatService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly database: DatabaseService,
    private readonly memory: MemoryService,
    private readonly models: ModelRouterService,
    private readonly ghl: GhlAdapter,
    private readonly tokens: GhlTokenService,
  ) {}

  publicConfig() { return { bookingUrl: this.config.marketing.bookingUrl || null }; }

  async startSession(website?: string) {
    const session = await this.createSession(this.organizationId(), website);
    return { sessionId: session.id, sessionToken: session.token };
  }

  async chat(dto: MarketingChatRequestDto) {
    const organizationId = this.organizationId();
    const session = dto.sessionId && dto.sessionToken
      ? await this.verifySession(organizationId, dto.sessionId, dto.sessionToken)
      : await this.createSession(organizationId, dto.website);
    const history = (await this.memory.recent(organizationId, session.id, 10))
      .filter((turn) => turn.role === 'user' || turn.role === 'assistant')
      .map((turn) => ({ role: turn.role as 'user' | 'assistant', content: turn.content }));
    await this.memory.append({ sessionId: session.id, organizationId, role: 'user', content: dto.message.trim(), metadata: { source: 'marketing_website' } });
    const completion = await this.models.complete({
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history, { role: 'user', content: dto.message.trim() }],
      temperature: 0.25,
      maxTokens: 450,
      responseFormat: { type: 'text' },
    }, { organizationId, sessionId: session.id, agent: 'cmo', taskType: 'cheap', metadata: { source: 'marketing_website' } });
    const reply = completion.content.trim() || 'I could not prepare a response. Please book a CPA Growth Review and our team will help directly.';
    await this.memory.append({ sessionId: session.id, organizationId, role: 'assistant', content: reply, metadata: { source: 'marketing_website' } });
    return { sessionId: session.id, sessionToken: session.token, message: reply, bookingUrl: this.config.marketing.bookingUrl || null };
  }

  async captureLead(dto: MarketingLeadDto) {
    const organizationId = this.organizationId();
    await this.verifySession(organizationId, dto.sessionId, dto.sessionToken);
    const storedAt = new Date().toISOString();
    const current = await this.database.db.selectFrom('capere.ai_sessions').select('metadata').where('organization_id', '=', organizationId).where('id', '=', dto.sessionId).executeTakeFirstOrThrow();
    const metadata = this.record(current.metadata);
    await this.database.db.updateTable('capere.ai_sessions').set({ metadata: JSON.stringify({ ...metadata, lead: { name: dto.name.trim(), email: dto.email.trim().toLowerCase(), phone: dto.phone?.trim() || null, firmName: dto.firmName.trim(), website: dto.website?.trim() || null, storedAt } }), updated_at: new Date() }).where('organization_id', '=', organizationId).where('id', '=', dto.sessionId).execute();
    let ghlContactId: string | null = null;
    try {
      const integration = await this.database.db.selectFrom('capere.integrations').select(['id', 'ghl_location_id']).where('organization_id', '=', organizationId).where('provider', '=', 'go_high_level').where('status', '=', 'connected').where('ghl_location_id', 'is not', null).orderBy('updated_at', 'desc').executeTakeFirst();
      if (integration?.ghl_location_id) {
        const credentials = await this.tokens.credentials(organizationId, integration.id);
        const parts = dto.name.trim().split(/\s+/);
        const response = await this.ghl.postJson<{ contact?: { id?: string } }>(credentials, '/contacts/upsert', {
          locationId: integration.ghl_location_id,
          firstName: parts[0],
          lastName: parts.slice(1).join(' '),
          name: dto.name.trim(),
          email: dto.email.trim().toLowerCase(),
          phone: dto.phone?.trim() || undefined,
          website: dto.website?.trim() || undefined,
          companyName: dto.firmName.trim(),
          source: 'Capere website chatbot',
          tags: ['Capere Website Lead', 'CPA Growth Review'],
        });
        ghlContactId = response.contact?.id ?? null;
      }
    } catch (error) {
      this.logger.warn(`Website lead was stored but GHL sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { saved: true, ghlContactId, bookingUrl: this.config.marketing.bookingUrl || null };
  }

  private organizationId(): string {
    if (!this.config.marketing.organizationId) throw AppException.serviceUnavailable(ErrorCode.SERVICE_UNAVAILABLE, 'Website assistant is temporarily unavailable');
    return this.config.marketing.organizationId;
  }

  private async createSession(organizationId: string, website?: string) {
    const token = randomBytes(32).toString('base64url');
    const row = await this.database.db.insertInto('capere.ai_sessions').values({ organization_id: organizationId, user_id: null, agent: 'cmo', title: 'Website visitor', metadata: JSON.stringify({ source: 'marketing_website', visitorTokenHash: this.tokenHash(token), website: website?.trim() || null }) }).returning('id').executeTakeFirstOrThrow();
    return { id: row.id, token };
  }

  private async verifySession(organizationId: string, sessionId: string, token: string) {
    const row = await this.database.db.selectFrom('capere.ai_sessions').select(['id', 'metadata']).where('organization_id', '=', organizationId).where('id', '=', sessionId).where('status', '=', 'active').executeTakeFirst();
    const expected = this.record(row?.metadata)['visitorTokenHash'];
    const actualHash = this.tokenHash(token);
    if (!row || typeof expected !== 'string' || expected.length !== actualHash.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(actualHash))) throw AppException.notFound(ErrorCode.NOT_FOUND, 'Website conversation not found');
    return { id: row.id, token };
  }

  private tokenHash(token: string) { return createHash('sha256').update(`${this.config.auth.apiKeyHashingSalt}:${token}`).digest('hex'); }

  private record(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    if (typeof value === 'string') { try { const parsed = JSON.parse(value) as unknown; if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>; } catch {} }
    return {};
  }
}
