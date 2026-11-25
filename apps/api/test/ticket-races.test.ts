/**
 * Code review M1, M2, L1, L2, L3: counters under concurrent closes, warranty on the same device, customer locks
 * against a concurrent erase, CHECK violations from status re-categorisation, and a timeline that survives
 * unknown ids.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { TimelineResponse } from '@repairos/contracts';
import { PrismaClient } from '@repairos/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { whileLocked } from './concurrency';
import { ownerWithShop, type OwnerWithShop } from './fixtures';
import { createTestApp } from './helpers';
import { checkInExisting, checkInNew, imei, statuses } from './s2';

let app: NestExpressApplication;
let adminDb: PrismaClient;
let owner: OwnerWithShop;
let st: Record<string, { id: string; category: string }>;

beforeAll(async () => {
  app = await createTestApp();
  adminDb = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL_TEST });
  owner = await ownerWithShop(app, { shopName: 'Race Shop' });
  st = await statuses(owner.agent);
});
afterAll(async () => {
  await adminDb?.$disconnect();
  await app?.close();
});

const toReady = (id: string) => owner.agent.post(`/api/tickets/${id}/status`).send({ statusId: st['Ready for pickup']!.id }).expect(200);
const collect = (id: string) => owner.agent.post(`/api/tickets/${id}/status`).send({ statusId: st.Collected!.id });

async function addDevice(customerId: string, seed: number): Promise<string> {
  const res = await owner.agent
    .post(`/api/customers/${customerId}/devices`)
    .send({ type: 'PHONE', brand: 'Samsung', model: 'Galaxy S23', imei: imei(seed) })
    .expect(201);
  return (res.body as { id: string }).id;
}

describe('M1: openTicketCount under concurrent closes', () => {
  it('two tickets of one customer closed at the same time → openTicketCount 0 (race repeated)', async () => {
    for (let i = 0; i < 6; i++) {
      const t1 = await checkInNew(owner.agent);
      const d2 = await addDevice(t1.customer.id, 700_000 + i);
      const t2 = await checkInExisting(owner.agent, t1.customer.id, d2);
      await toReady(t1.id);
      const [a, b] = await Promise.all([collect(t1.id), owner.agent.post(`/api/tickets/${t2.id}/cancel`).send({ reason: 'DUPLICATE' })]);
      expect([a.status, b.status]).toEqual([200, 200]);
      const c = await adminDb.customer.findUniqueOrThrow({ where: { id: t1.customer.id }, select: { openTicketCount: true } });
      expect(c.openTicketCount).toBe(0);
    }
  });
});

describe('M2: warranty only for a Collected ticket of the same device', () => {
  it('another device of the same customer → 409 WARRANTY_NOT_ALLOWED; same device → 201', async () => {
    const original = await checkInNew(owner.agent);
    await toReady(original.id);
    await collect(original.id).expect(200);
    const otherDevice = await addDevice(original.customer.id, 710_001);
    const wrong = await owner.agent
      .post('/api/tickets')
      .send({ customerId: original.customer.id, deviceId: otherDevice, issues: [{ code: 'BATTERY' }], warrantyOfTicketId: original.id });
    expect(wrong.status).toBe(409);
    expect(wrong.body.code).toBe('WARRANTY_NOT_ALLOWED');

    const newDevice = await owner.agent.post('/api/tickets').send({
      customerId: original.customer.id,
      newDevice: { type: 'PHONE', brand: 'Apple', model: 'iPhone 13', imei: imei(710_002) },
      issues: [{ code: 'BATTERY' }],
      warrantyOfTicketId: original.id,
    });
    expect(newDevice.status).toBe(409);
    expect(newDevice.body.code).toBe('WARRANTY_NOT_ALLOWED');

    const ok = await checkInExisting(owner.agent, original.customer.id, original.device.id, { warrantyOfTicketId: original.id });
    expect(ok.warrantyOf?.id).toBe(original.id);
  });
});

/** What app_erase_customer does to the rows a concurrent request could race with (owner role, uncommitted). */
async function eraseLike(tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0], customerId: string) {
  await tx.$queryRaw`SELECT id FROM customers WHERE id = ${customerId} FOR UPDATE`;
  await tx.$executeRaw`UPDATE devices SET imei = NULL, serial = NULL, colour = NULL, notes = NULL WHERE "customerId" = ${customerId}`;
  await tx.$executeRaw`UPDATE customers SET "erasedAt" = now(), "archivedAt" = now(), "firstName" = NULL, "lastName" = NULL,
                         "displayName" = 'Erased customer' WHERE id = ${customerId}`;
}

describe('L1: customer row locked against a concurrent erase', () => {
  it('ticket PATCH moving a ticket to a customer being erased waits for the erase → 409 CUSTOMER_ERASED', async () => {
    const t = await checkInNew(owner.agent);
    const target = await checkInNew(owner.agent, { firstName: 'Target', lastName: 'Person' });
    await owner.agent.post(`/api/tickets/${target.id}/cancel`).send({ reason: 'DUPLICATE' }).expect(200);
    const res = await whileLocked(
      adminDb,
      (tx) => eraseLike(tx, target.customer.id),
      () => owner.agent.patch(`/api/tickets/${t.id}`).send({ version: t.version, customerId: target.customer.id, deviceId: target.device.id }),
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CUSTOMER_ERASED');
    const row = await adminDb.ticket.findUniqueOrThrow({ where: { id: t.id }, select: { customerId: true } });
    expect(row.customerId).toBe(t.customer.id);
  });

  it('device PATCH racing an erase cannot write the IMEI back → 409 CUSTOMER_ERASED', async () => {
    const t = await checkInNew(owner.agent);
    await owner.agent.post(`/api/tickets/${t.id}/cancel`).send({ reason: 'DUPLICATE' }).expect(200);
    const newImei = imei(720_001);
    const res = await whileLocked(
      adminDb,
      (tx) => eraseLike(tx, t.customer.id),
      () => owner.agent.patch(`/api/devices/${t.device.id}`).send({ imei: newImei, notes: 'Back cover scratched' }),
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CUSTOMER_ERASED');
    const d = await adminDb.device.findUniqueOrThrow({ where: { id: t.device.id }, select: { imei: true, notes: true } });
    expect(d).toEqual({ imei: null, notes: null });
  });
});

describe('L2: CHECK violations from a status category change race → 409 STATUS_IN_USE', () => {
  it('a ticket entering the status while it is re-categorised to closed', async () => {
    const created = await owner.agent.post('/api/ticket-statuses').send({ name: 'Bench 2', category: 'OPEN', colour: 'blue' }).expect(201);
    const statusId = (created.body as { id: string }).id;
    const t = await checkInNew(owner.agent);
    const res = await whileLocked(
      adminDb,
      (tx) => tx.$executeRaw`UPDATE tickets SET "statusId" = ${statusId}, "statusCategory" = 'OPEN' WHERE id = ${t.id}`,
      () => owner.agent.patch(`/api/ticket-statuses/${statusId}`).send({ category: 'CLOSED' }),
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('STATUS_IN_USE');
    const s = await adminDb.ticketStatus.findUniqueOrThrow({ where: { id: statusId }, select: { category: true } });
    expect(s.category).toBe('OPEN');
  });
});

describe('L3: timeline with unknown ids', () => {
  it('an event pointing at a status id that does not exist maps to "Unknown status" instead of a 500', async () => {
    const t = await checkInNew(owner.agent);
    await adminDb.ticketEvent.create({
      data: {
        shopId: owner.shopId,
        ticketId: t.id,
        type: 'status_changed',
        actorUserId: owner.userId,
        data: { fromStatusId: 'no-such-status', toStatusId: st.Diagnosing!.id, notifyPending: false },
      },
    });
    await adminDb.ticketEvent.create({
      data: { shopId: owner.shopId, ticketId: t.id, type: 'created', actorUserId: owner.userId, data: { statusId: 'gone', warrantyOfTicketId: null } },
    });
    const res = await owner.agent.get(`/api/tickets/${t.id}/timeline`);
    expect(res.status).toBe(200);
    const tl = TimelineResponse.parse(res.body);
    const changed = tl.items.find((i) => i.type === 'status_changed');
    expect(changed).toMatchObject({ data: { from: { id: 'no-such-status', name: 'Unknown status' }, to: { name: 'Diagnosing' } } });
    expect(tl.items.filter((i) => i.type === 'created').map((i) => (i.data as { status: { name: string } }).status.name)).toContain('Unknown status');
  });
});
