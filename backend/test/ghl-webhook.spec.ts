import { generateKeyPairSync, sign } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GhlWebhookService } from '../src/integrations/ghl/ghl-webhook.service';
import type { AppConfig } from '../src/shared/config';
import type { DatabaseService } from '../src/shared/database';
import { OutboxService } from '../src/shared/events';
import {
  cleanup,
  closeDb,
  seedTwoOrganizations,
  serviceDb,
  type Fixture,
} from './helpers/database';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const ed25519Keys = generateKeyPairSync('ed25519');
const ed25519PublicKey = ed25519Keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

function database(): DatabaseService {
  return {
    db: serviceDb(),
    transaction: (fn) => serviceDb().transaction().execute(fn),
  } as DatabaseService;
}

function signature(body: Buffer): string {
  return sign('RSA-SHA256', body, keys.privateKey).toString('base64');
}

describe('GHL Marketplace webhooks', () => {
  let fixture: Fixture;
  let service: GhlWebhookService;

  beforeEach(async () => {
    fixture = await seedTwoOrganizations();
    const db = database();
    service = new GhlWebhookService(
      {
        ghl: { webhookPublicKey: publicKey, webhookSecret: '' },
      } as unknown as AppConfig,
      db,
      new OutboxService(db),
    );
    await serviceDb()
      .insertInto('capere.integrations')
      .values({
        organization_id: fixture.orgAId,
        provider: 'go_high_level',
        account_id: 'location-webhook',
        status: 'connected',
      })
      .execute();
  });

  afterEach(async () => cleanup(fixture));
  afterAll(closeDb);

  it('accepts a signed contact event, resolves its tenant, and publishes lead.captured once', async () => {
    const body = Buffer.from(
      JSON.stringify({
        type: 'ContactCreate',
        eventId: 'event-1',
        locationId: 'location-webhook',
        contactId: 'contact-1',
        source: 'Website',
      }),
    );
    const headers = { 'x-wh-signature': signature(body), 'content-type': 'application/json' };
    await expect(service.receive(body, headers)).resolves.toEqual({ accepted: true, processed: true });
    await expect(service.receive(body, headers)).resolves.toEqual({
      accepted: true,
      processed: false,
      duplicate: true,
    });
    const event = await serviceDb()
      .selectFrom('capere.domain_events')
      .select(['organization_id', 'type', 'payload'])
      .where('organization_id', '=', fixture.orgAId)
      .where('type', '=', 'lead.captured')
      .executeTakeFirstOrThrow();
    expect(event.payload).toMatchObject({
      ghlContactId: 'contact-1',
      ghlLocationId: 'location-webhook',
      source: 'Website',
    });
    const eventCount = await serviceDb()
      .selectFrom('capere.domain_events')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('organization_id', '=', fixture.orgAId)
      .where('type', '=', 'lead.captured')
      .executeTakeFirstOrThrow();
    expect(Number(eventCount.count)).toBe(1);
  });

  it('maps the official contact resource id shape without treating it as an event id', async () => {
    const created = Buffer.from(
      JSON.stringify({
        type: 'ContactCreate',
        id: 'contact-official-shape',
        locationId: 'location-webhook',
        source: 'Website',
      }),
    );
    const updated = Buffer.from(
      JSON.stringify({
        type: 'ContactUpdate',
        id: 'contact-official-shape',
        locationId: 'location-webhook',
      }),
    );

    await expect(
      service.receive(created, { 'x-wh-signature': signature(created) }),
    ).resolves.toEqual({ accepted: true, processed: true });
    await expect(
      service.receive(updated, { 'x-wh-signature': signature(updated) }),
    ).resolves.toEqual({ accepted: true, processed: true });

    const logs = await serviceDb()
      .selectFrom('capere.webhook_logs')
      .select(['event_type', 'provider_event_id', 'body'])
      .where('organization_id', '=', fixture.orgAId)
      .where('provider', '=', 'go_high_level')
      .orderBy('received_at')
      .execute();
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({
      event_type: 'ContactCreate',
      provider_event_id: null,
      body: { contactId: 'contact-official-shape' },
    });
    expect(logs[1]).toMatchObject({
      event_type: 'ContactUpdate',
      provider_event_id: null,
      body: { contactId: 'contact-official-shape' },
    });

    const event = await serviceDb()
      .selectFrom('capere.domain_events')
      .select('payload')
      .where('organization_id', '=', fixture.orgAId)
      .where('type', '=', 'lead.captured')
      .executeTakeFirstOrThrow();
    expect(event.payload).toMatchObject({ ghlContactId: 'contact-official-shape' });
  });

  it('publishes an opportunity event instead of misclassifying it as a new lead', async () => {
    const body = Buffer.from(
      JSON.stringify({
        type: 'OpportunityCreate',
        id: 'opportunity-1',
        contactId: 'contact-1',
        locationId: 'location-webhook',
        monetaryValue: 1000,
        pipelineId: 'pipeline-1',
        pipelineStageId: 'stage-1',
        status: 'open',
      }),
    );

    await expect(
      service.receive(body, { 'x-wh-signature': signature(body) }),
    ).resolves.toEqual({ accepted: true, processed: true });

    const events = await serviceDb()
      .selectFrom('capere.domain_events')
      .select(['type', 'aggregate_type', 'payload'])
      .where('organization_id', '=', fixture.orgAId)
      .execute();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'opportunity.created',
      aggregate_type: 'ghl_opportunity_reference',
      payload: {
        ghlOpportunityId: 'opportunity-1',
        ghlContactId: 'contact-1',
        ghlLocationId: 'location-webhook',
        monetaryValue: 1000,
        pipelineId: 'pipeline-1',
        pipelineStageId: 'stage-1',
        status: 'open',
      },
    });
  });

  it.each([
    ['OpportunityUpdate', 'opportunity.updated'],
    ['OpportunityStageUpdate', 'opportunity.stage_updated'],
    ['OpportunityStatusUpdate', 'opportunity.status_updated'],
  ])('maps %s resource ids and publishes %s', async (webhookType, eventType) => {
    const body = Buffer.from(
      JSON.stringify({
        type: webhookType,
        id: `opportunity-${webhookType}`,
        contactId: 'contact-1',
        locationId: 'location-webhook',
        monetaryValue: 2000,
        pipelineId: 'pipeline-1',
        pipelineStageId: 'stage-2',
        status: 'open',
      }),
    );

    await expect(
      service.receive(body, { 'x-wh-signature': signature(body) }),
    ).resolves.toEqual({ accepted: true, processed: true });

    const log = await serviceDb()
      .selectFrom('capere.webhook_logs')
      .select('body')
      .where('organization_id', '=', fixture.orgAId)
      .where('event_type', '=', webhookType)
      .executeTakeFirstOrThrow();
    expect(log.body).toMatchObject({ opportunityId: `opportunity-${webhookType}` });

    const event = await serviceDb()
      .selectFrom('capere.domain_events')
      .select(['type', 'payload'])
      .where('organization_id', '=', fixture.orgAId)
      .where('type', '=', eventType)
      .executeTakeFirstOrThrow();
    expect(event.payload).toMatchObject({
      ghlOpportunityId: `opportunity-${webhookType}`,
      ghlLocationId: 'location-webhook',
      ghlContactId: 'contact-1',
      monetaryValue: 2000,
      pipelineStageId: 'stage-2',
    });
  });

  it.each([
    ['AppointmentCreate', 'appointment.created'],
    ['AppointmentUpdate', 'appointment.updated'],
  ])('maps %s references and publishes %s without free text', async (webhookType, eventType) => {
    const body = Buffer.from(
      JSON.stringify({
        type: webhookType,
        locationId: 'location-webhook',
        appointment: {
          id: `appointment-${webhookType}`,
          contactId: 'contact-1',
          calendarId: 'calendar-1',
          assignedUserId: 'user-1',
          appointmentStatus: 'confirmed',
          startTime: '2026-08-08T09:00:00.000Z',
          endTime: '2026-08-08T09:30:00.000Z',
          title: 'Potentially sensitive free text',
          notes: 'Potentially sensitive notes',
        },
      }),
    );

    await expect(
      service.receive(body, { 'x-wh-signature': signature(body) }),
    ).resolves.toEqual({ accepted: true, processed: true });

    const log = await serviceDb()
      .selectFrom('capere.webhook_logs')
      .select('body')
      .where('organization_id', '=', fixture.orgAId)
      .where('event_type', '=', webhookType)
      .executeTakeFirstOrThrow();
    expect(log.body).toMatchObject({
      appointmentId: `appointment-${webhookType}`,
      calendarId: 'calendar-1',
      appointmentStatus: 'confirmed',
    });
    expect(log.body).not.toHaveProperty('title');

    const event = await serviceDb()
      .selectFrom('capere.domain_events')
      .select(['type', 'aggregate_type', 'payload'])
      .where('organization_id', '=', fixture.orgAId)
      .where('type', '=', eventType)
      .executeTakeFirstOrThrow();
    expect(event).toMatchObject({
      type: eventType,
      aggregate_type: 'ghl_appointment_reference',
      payload: {
        ghlAppointmentId: `appointment-${webhookType}`,
        ghlLocationId: 'location-webhook',
        ghlContactId: 'contact-1',
        ghlCalendarId: 'calendar-1',
        appointmentStatus: 'confirmed',
      },
    });
    expect(event.payload).not.toHaveProperty('title');
  });

  it('rejects a tampered payload and records no domain event', async () => {
    const signed = Buffer.from(
      JSON.stringify({ type: 'ContactCreate', locationId: 'location-webhook', contactId: 'one' }),
    );
    const tampered = Buffer.from(
      JSON.stringify({ type: 'ContactCreate', locationId: 'location-webhook', contactId: 'two' }),
    );
    await expect(
      service.receive(tampered, { 'x-wh-signature': signature(signed) }),
    ).rejects.toThrow('Invalid webhook signature');
    const events = await serviceDb()
      .selectFrom('capere.domain_events')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('organization_id', '=', fixture.orgAId)
      .where('type', '=', 'lead.captured')
      .executeTakeFirstOrThrow();
    expect(Number(events.count)).toBe(0);
  });

  it('accepts a valid event for an unknown location without assigning it to a tenant', async () => {
    const body = Buffer.from(
      JSON.stringify({ type: 'ContactCreate', locationId: 'unknown', contactId: 'contact-2' }),
    );
    await expect(
      service.receive(body, { 'x-wh-signature': signature(body) }),
    ).resolves.toEqual({ accepted: true, processed: false });
  });

  it('prefers the modern Ed25519 signature and does not downgrade to valid RSA', async () => {
    const db = database();
    const modern = new GhlWebhookService(
      {
        ghl: {
          webhookEd25519PublicKey: ed25519PublicKey,
          webhookPublicKey: publicKey,
          webhookSecret: '',
        },
      } as unknown as AppConfig,
      db,
      new OutboxService(db),
    );
    const body = Buffer.from(
      JSON.stringify({ type: 'ContactUpdate', locationId: 'unknown', contactId: 'contact-3' }),
    );
    const ed25519Signature = sign(null, body, ed25519Keys.privateKey).toString('base64');
    await expect(
      modern.receive(body, {
        'x-ghl-signature': ed25519Signature,
        'x-wh-signature': signature(body),
      }),
    ).resolves.toEqual({ accepted: true, processed: false });
    await expect(
      modern.receive(body, {
        'x-ghl-signature': Buffer.alloc(64).toString('base64'),
        'x-wh-signature': signature(body),
      }),
    ).rejects.toThrow('Invalid webhook signature');
  });
});
