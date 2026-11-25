/**
 * Code review H1 + L4: the passcode is deleted when the last non-closed ticket of its device closes, even when two
 * tickets of one device close at the same time or a ticket moves to another device; the reveal cannot slip past a
 * concurrent close.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
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
  owner = await ownerWithShop(app, { shopName: 'Passcode Race Shop' });
  st = await statuses(owner.agent);
});
afterAll(async () => {
  await adminDb?.$disconnect();
  await app?.close();
});

const passcodeOnFile = async (deviceId: string) =>
  (await adminDb.device.findUniqueOrThrow({ where: { id: deviceId }, select: { passcodeKeyVersion: true } })).passcodeKeyVersion !== null;

async function toReady(id: string) {
  await owner.agent.post(`/api/tickets/${id}/status`).send({ statusId: st['Ready for pickup']!.id }).expect(200);
}

describe('H1: passcode deleted on the last close', () => {
  it('two tickets of one device collected at the same time → passcode deleted (race repeated)', async () => {
    for (let i = 0; i < 6; i++) {
      const t1 = await checkInNew(owner.agent, { passcode: { lockType: 'PIN', value: '2468' } });
      const t2 = await checkInExisting(owner.agent, t1.customer.id, t1.device.id);
      await toReady(t1.id);
      await toReady(t2.id);
      const [a, b] = await Promise.all([
        owner.agent.post(`/api/tickets/${t1.id}/status`).send({ statusId: st.Collected!.id }),
        owner.agent.post(`/api/tickets/${t2.id}/status`).send({ statusId: st.Collected!.id }),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(await passcodeOnFile(t1.device.id)).toBe(false);
    }
  });

  it('collect and cancel of two tickets of one device at the same time → passcode deleted', async () => {
    for (let i = 0; i < 4; i++) {
      const t1 = await checkInNew(owner.agent, { passcode: { lockType: 'PIN', value: '1357' } });
      const t2 = await checkInExisting(owner.agent, t1.customer.id, t1.device.id);
      await toReady(t1.id);
      const [a, b] = await Promise.all([
        owner.agent.post(`/api/tickets/${t1.id}/status`).send({ statusId: st.Collected!.id }),
        owner.agent.post(`/api/tickets/${t2.id}/cancel`).send({ reason: 'DUPLICATE' }),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(await passcodeOnFile(t1.device.id)).toBe(false);
    }
  });

  it('a ticket moved to another device: the old device loses its passcode (no other open ticket), the new one on close', async () => {
    const t = await checkInNew(owner.agent, { passcode: { lockType: 'PIN', value: '9753' } });
    const other = await owner.agent
      .post(`/api/customers/${t.customer.id}/devices`)
      .send({ type: 'PHONE', brand: 'Google', model: 'Pixel 8', imei: imei(424242), passcode: { lockType: 'PIN', value: '8642' } })
      .expect(201);
    const newDeviceId = (other.body as { id: string }).id;
    const moved = await owner.agent.patch(`/api/tickets/${t.id}`).send({ version: t.version, deviceId: newDeviceId }).expect(200);
    expect(moved.body.device.id).toBe(newDeviceId);
    expect(await passcodeOnFile(t.device.id)).toBe(false);
    expect(await passcodeOnFile(newDeviceId)).toBe(true);

    await toReady(t.id);
    await owner.agent.post(`/api/tickets/${t.id}/status`).send({ statusId: st.Collected!.id }).expect(200);
    expect(await passcodeOnFile(newDeviceId)).toBe(false);
  });

  it('the old device keeps its passcode while another of its tickets is open', async () => {
    const t1 = await checkInNew(owner.agent, { passcode: { lockType: 'PIN', value: '5555' } });
    await checkInExisting(owner.agent, t1.customer.id, t1.device.id);
    const other = await owner.agent
      .post(`/api/customers/${t1.customer.id}/devices`)
      .send({ type: 'PHONE', brand: 'Google', model: 'Pixel 7', imei: imei(434343) })
      .expect(201);
    await owner.agent.patch(`/api/tickets/${t1.id}`).send({ version: t1.version, deviceId: other.body.id }).expect(200);
    expect(await passcodeOnFile(t1.device.id)).toBe(true);
  });

  it('device change with the shop setting off keeps the old passcode', async () => {
    await owner.agent.patch('/api/shop/ticket-settings').send({ deletePasscodeOnClose: false }).expect(200);
    try {
      const t = await checkInNew(owner.agent, { passcode: { lockType: 'PIN', value: '1212' } });
      const other = await owner.agent
        .post(`/api/customers/${t.customer.id}/devices`)
        .send({ type: 'PHONE', brand: 'Google', model: 'Pixel 6', imei: imei(454545) })
        .expect(201);
      await owner.agent.patch(`/api/tickets/${t.id}`).send({ version: t.version, deviceId: other.body.id }).expect(200);
      expect(await passcodeOnFile(t.device.id)).toBe(true);
    } finally {
      await owner.agent.patch('/api/shop/ticket-settings').send({ deletePasscodeOnClose: true }).expect(200);
    }
  });
});

describe('L4: reveal vs a concurrent close', () => {
  it('a reveal that starts while the ticket is being closed waits for the close and is refused', async () => {
    const t = await checkInNew(owner.agent, { passcode: { lockType: 'PIN', value: '4321' } });
    const res = await whileLocked(
      adminDb,
      (tx) =>
        tx.$executeRaw`UPDATE tickets SET "statusId" = ${st.Collected!.id}, "statusCategory" = 'CLOSED', "closedAt" = now(),
                                          "statusIdBeforeClose" = "statusId" WHERE id = ${t.id}`,
      () => owner.agent.post(`/api/tickets/${t.id}/passcode/reveal`),
    );
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PASSCODE_NOT_AVAILABLE');
  });
});
