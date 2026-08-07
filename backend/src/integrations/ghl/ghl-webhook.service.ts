import { createHash, createHmac, createVerify, timingSafeEqual, verify } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../shared/config';
import { DatabaseService } from '../../shared/database';
import { EventType, OutboxService } from '../../shared/events';
import { AppException, ErrorCode } from '../../shared/http';

interface GhlAppointmentPayload {
  id?: string;
  contactId?: string;
  calendarId?: string;
  assignedUserId?: string;
  appointmentStatus?: string;
  startTime?: string;
  endTime?: string;
}

interface GhlWebhookPayload extends GhlAppointmentPayload {
  type?: string;
  locationId?: string;
  id?: string;
  contactId?: string;
  opportunityId?: string;
  monetaryValue?: number;
  pipelineId?: string;
  pipelineStageId?: string;
  status?: string;
  calendarId?: string;
  assignedUserId?: string;
  appointmentStatus?: string;
  startTime?: string;
  endTime?: string;
  appointment?: GhlAppointmentPayload;
  source?: string;
  eventId?: string;
}

// Published by HighLevel in the official Webhook Integration Guide. These are
// verification keys, not secrets. Environment overrides exist for controlled
// key rotation without a deploy.
const OFFICIAL_GHL_ED25519_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=
-----END PUBLIC KEY-----`;

const OFFICIAL_GHL_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAokvo/r9tVgcfZ5DysOSC
Frm602qYV0MaAiNnX9O8KxMbiyRKWeL9JpCpVpt4XHIcBOK4u3cLSqJGOLaPuXw6
dO0t6Q/ZVdAV5Phz+ZtzPL16iCGeK9po6D6JHBpbi989mmzMryUnQJezlYJ3DVfB
csedpinheNnyYeFXolrJvcsjDtfAeRx5ByHQmTnSdFUzuAnC9/GepgLT9SM4nCpv
uxmZMxrJt5Rw+VUaQ9B8JSvbMPpez4peKaJPZHBbU3OdeCVx5klVXXZQGNHOs8gF
3kvoV5rTnXV0IknLBXlcKKAQLZcY/Q9rG6Ifi9c+5vqlvHPCUJFT5XUGG5RKgOKU
J062fRtN+rLYZUV+BjafxQauvC8wSWeYja63VSUruvmNj8xkx2zE/Juc+yjLjTXp
IocmaiFeAO6fUtNjDeFVkhf5LNb59vECyrHD2SQIrhgXpO4Q3dVNA5rw576PwTzN
h/AMfHKIjE4xQA1SZuYJmNnmVZLIZBlQAF9Ntd03rfadZ+yDiOXCCs9FkHibELhC
HULgCsnuDJHcrGNd5/Ddm5hxGQ0ASitgHeMZ0kcIOwKDOzOU53lDza6/Y09T7sYJ
PQe7z0cvj7aE4B+Ax1ZoZGPzpJlZtGXCsu9aTEGEnKzmsFqwcSsnw3JB31IGKAyk
T1hhTiaCeIY/OwwwNUY2yvcCAwEAAQ==
-----END PUBLIC KEY-----`;

@Injectable()
export class GhlWebhookService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly database: DatabaseService,
    private readonly outbox: OutboxService,
  ) {}

  async receive(rawBody: Buffer, headers: Record<string, string | string[] | undefined>) {
    const ghlSignature = this.header(headers, 'x-ghl-signature');
    const rsaSignature = this.header(headers, 'x-wh-signature');
    const legacyHmacSignature = this.header(headers, 'x-webhook-signature');
    const signatureValid = this.verify(
      rawBody,
      ghlSignature,
      rsaSignature,
      legacyHmacSignature,
    );
    const payloadHash = createHash('sha256').update(rawBody).digest('hex');
    let payload: GhlWebhookPayload;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as GhlWebhookPayload;
    } catch {
      throw AppException.badRequest(ErrorCode.BAD_REQUEST, 'Webhook body is not valid JSON');
    }
    const locationId = payload.locationId;
    const integration = locationId
      ? await this.database.db
          .selectFrom('capere.integrations')
          .select(['id', 'organization_id'])
          .where('provider', '=', 'go_high_level')
          .where('account_id', '=', locationId)
          .where('status', '=', 'connected')
          .executeTakeFirst()
      : undefined;
    if (!signatureValid) {
      await this.log(
        null,
        payload,
        headers,
        false,
        payload.eventId ?? null,
        payloadHash,
        'rejected',
        'Invalid signature',
      );
      throw AppException.unauthorized(ErrorCode.INVALID_TOKEN, 'Invalid webhook signature');
    }
    if (!integration) {
      await this.log(
        null,
        payload,
        headers,
        true,
        payload.eventId ?? null,
        payloadHash,
        'ignored',
        'Unknown GHL location',
      );
      return { accepted: true, processed: false };
    }
    // HighLevel uses `id` for the resource identifier in several webhook
    // payloads (for example, ContactCreate). It is not a delivery/event id and
    // must not be used for cross-event deduplication: ContactCreate and a later
    // ContactUpdate can legitimately carry the same resource id.
    const eventId = payload.eventId ?? null;
    const contactId = this.contactId(payload);
    return this.database.transaction(async (trx) => {
      const row = await trx
        .insertInto('capere.webhook_logs')
        .values({
          organization_id: integration.organization_id,
          provider: 'go_high_level',
          event_type: payload.type ?? null,
          headers: JSON.stringify(this.safeHeaders(headers)),
          body: JSON.stringify(this.safeBody(payload)),
          signature_valid: true,
          processing_status: 'processed',
          processing_error: null,
          provider_event_id: eventId,
          payload_hash: payloadHash,
          received_at: new Date(),
        })
        .onConflict((c) =>
          eventId
            ? c
                .columns(['provider', 'provider_event_id'])
                .where('provider_event_id', 'is not', null)
                .doNothing()
            : c
                .columns(['provider', 'payload_hash'])
                .where('provider_event_id', 'is', null)
                .doNothing(),
        )
        .returning('id')
        .executeTakeFirst();
      if (!row) return { accepted: true, processed: false, duplicate: true };
      if (this.isContactLead(payload) && contactId && locationId) {
        await this.outbox.publishInTransaction(trx, {
          type: EventType.LeadCaptured,
          organizationId: integration.organization_id,
          aggregateType: 'ghl_contact_reference',
          // GHL identifiers are opaque provider strings, while domain_events.aggregate_id
          // is an internal UUID. Keep the provider id in the typed payload instead of
          // coercing it into an incompatible internal identity column.
          payload: {
            ghlContactId: contactId,
            ghlLocationId: locationId,
            source: payload.source,
          },
        });
      }
      const opportunityId = this.opportunityId(payload);
      const opportunityEventType = this.opportunityEventType(payload);
      if (opportunityId && locationId && opportunityEventType) {
        await this.outbox.publishInTransaction(trx, {
          type: opportunityEventType,
          organizationId: integration.organization_id,
          aggregateType: 'ghl_opportunity_reference',
          payload: {
            ghlOpportunityId: opportunityId,
            ghlLocationId: locationId,
            ghlContactId: contactId,
            monetaryValue: payload.monetaryValue,
            pipelineId: payload.pipelineId,
            pipelineStageId: payload.pipelineStageId,
            status: payload.status,
          },
        });
      }
      const appointmentId = this.appointmentId(payload);
      const appointmentEventType = this.appointmentEventType(payload);
      if (appointmentId && locationId && appointmentEventType) {
        const appointment = this.appointmentData(payload);
        await this.outbox.publishInTransaction(trx, {
          type: appointmentEventType,
          organizationId: integration.organization_id,
          aggregateType: 'ghl_appointment_reference',
          payload: {
            ghlAppointmentId: appointmentId,
            ghlLocationId: locationId,
            ghlContactId: contactId,
            ghlCalendarId: appointment.calendarId,
            assignedUserId: appointment.assignedUserId,
            appointmentStatus: appointment.appointmentStatus,
            startTime: appointment.startTime,
            endTime: appointment.endTime,
          },
        });
      }
      return { accepted: true, processed: true };
    });
  }

  private verify(
    body: Buffer,
    ghlSignature?: string,
    rsaSignature?: string,
    legacyHmacSignature?: string,
  ): boolean {
    // HighLevel explicitly requires preferring this modern signature when both
    // headers are present. Never fall back after a present-but-invalid header.
    if (ghlSignature) {
      try {
        return verify(
          null,
          body,
          this.config.ghl.webhookEd25519PublicKey ?? OFFICIAL_GHL_ED25519_PUBLIC_KEY,
          Buffer.from(ghlSignature, 'base64'),
        );
      } catch {
        return false;
      }
    }
    if (rsaSignature) {
      try {
        const verifier = createVerify('RSA-SHA256');
        verifier.update(body);
        verifier.end();
        return verifier.verify(
          this.config.ghl.webhookPublicKey ?? OFFICIAL_GHL_RSA_PUBLIC_KEY,
          rsaSignature,
          'base64',
        );
      } catch {
        return false;
      }
    }
    if (!legacyHmacSignature || !this.config.ghl.webhookSecret) return false;
    const expected = createHmac('sha256', this.config.ghl.webhookSecret).update(body).digest('hex');
    const supplied = legacyHmacSignature.replace(/^sha256=/, '');
    if (expected.length !== supplied.length) return false;
    return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
  }
  private isContactLead(payload: GhlWebhookPayload): boolean {
    return [
      'ContactCreate',
      'contact.created',
    ].includes(payload.type ?? '');
  }
  private opportunityEventType(
    payload: GhlWebhookPayload,
  ):
    | typeof EventType.OpportunityCreated
    | typeof EventType.OpportunityUpdated
    | typeof EventType.OpportunityStageUpdated
    | typeof EventType.OpportunityStatusUpdated
    | undefined {
    switch (payload.type) {
      case 'OpportunityCreate':
      case 'opportunity.created':
        return EventType.OpportunityCreated;
      case 'OpportunityUpdate':
      case 'opportunity.updated':
        return EventType.OpportunityUpdated;
      case 'OpportunityStageUpdate':
      case 'opportunity.stage_updated':
        return EventType.OpportunityStageUpdated;
      case 'OpportunityStatusUpdate':
      case 'opportunity.status_updated':
        return EventType.OpportunityStatusUpdated;
      default:
        return undefined;
    }
  }
  private opportunityId(payload: GhlWebhookPayload): string | undefined {
    return payload.opportunityId ?? (this.opportunityEventType(payload) ? payload.id : undefined);
  }
  private appointmentEventType(
    payload: GhlWebhookPayload,
  ):
    | typeof EventType.AppointmentCreated
    | typeof EventType.AppointmentUpdated
    | undefined {
    switch (payload.type) {
      case 'AppointmentCreate':
      case 'appointment.created':
        return EventType.AppointmentCreated;
      case 'AppointmentUpdate':
      case 'appointment.updated':
        return EventType.AppointmentUpdated;
      default:
        return undefined;
    }
  }
  private appointmentId(payload: GhlWebhookPayload): string | undefined {
    return this.appointmentEventType(payload) ? this.appointmentData(payload).id : undefined;
  }
  private appointmentData(payload: GhlWebhookPayload): GhlAppointmentPayload {
    return payload.appointment ?? payload;
  }
  private contactId(payload: GhlWebhookPayload): string | undefined {
    if (payload.contactId) return payload.contactId;
    if (this.appointmentEventType(payload)) return payload.appointment?.contactId;
    return ['ContactCreate', 'ContactUpdate', 'contact.created', 'contact.updated'].includes(
      payload.type ?? '',
    )
      ? payload.id
      : undefined;
  }
  private safeBody(p: GhlWebhookPayload) {
    const appointment = this.appointmentData(p);
    return {
      type: p.type,
      locationId: p.locationId,
      contactId: this.contactId(p),
      opportunityId: this.opportunityId(p),
      appointmentId: this.appointmentId(p),
      calendarId: appointment.calendarId,
      assignedUserId: appointment.assignedUserId,
      appointmentStatus: appointment.appointmentStatus,
      startTime: appointment.startTime,
      endTime: appointment.endTime,
      source: p.source,
    };
  }
  private safeHeaders(h: Record<string, string | string[] | undefined>) {
    return {
      'user-agent': this.header(h, 'user-agent'),
      'content-type': this.header(h, 'content-type'),
      'x-wh-signature': this.header(h, 'x-wh-signature') ? '[present]' : undefined,
      'x-ghl-signature': this.header(h, 'x-ghl-signature') ? '[present]' : undefined,
    };
  }
  private header(
    h: Record<string, string | string[] | undefined>,
    name: string,
  ): string | undefined {
    const value = h[name];
    return Array.isArray(value) ? value[0] : value;
  }
  private async log(
    org: string | null,
    p: GhlWebhookPayload,
    h: Record<string, string | string[] | undefined>,
    valid: boolean,
    eventId: string | null,
    hash: string,
    status: string,
    error: string,
  ) {
    await this.database.db
      .insertInto('capere.webhook_logs')
      .values({
        organization_id: org,
        provider: 'go_high_level',
        event_type: p.type ?? null,
        headers: JSON.stringify(this.safeHeaders(h)),
        body: JSON.stringify(this.safeBody(p)),
        signature_valid: valid,
        processing_status: status,
        processing_error: error,
        provider_event_id: eventId,
        payload_hash: hash,
        received_at: new Date(),
      })
      .onConflict((c) => c.doNothing())
      .execute();
  }
}
