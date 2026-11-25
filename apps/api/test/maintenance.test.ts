/**
 * Daily worker maintenance as the app role with no shop selected: the passcode sweep (code review H1) and the
 * expired idempotency-key purge (backlog).
 */
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { IDEMPOTENCY_WINDOW_MINUTES } from '@repairos/contracts';
import { createPrismaClient, PrismaClient, purgeExpiredIdempotencyKeys, sweepUnusedPasscodes } from '@repairos/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerWithShop, type OwnerWithShop } from './fixtures';
import { createTestApp } from './helpers';
import { checkInExisting, checkInNew } from './s2';

let app: NestExpressApplication;
let adminDb: PrismaClient;
let appDb: PrismaClient;
let on: OwnerWithShop;
let off: OwnerWithShop;

beforeAll(async () => {
  app = await createTestApp();
  adminDb = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL_TEST });
  appDb = createPrismaClient(process.env.APP_DATABASE_URL_TEST);
  on = await ownerWithShop(app, { shopName: 'Sweep On' });
  off = await ownerWithShop(app, { shopName: 'Sweep Off' });
  await off.agent.patch('/api/shop/ticket-settings').send({ deletePasscodeOnClose: false }).expect(200);
});
afterAll(async () => {
  await appDb?.$disconnect();
  await adminDb?.$disconnect();
  await app?.close();
});

const PIN = { lockType: 'PIN' as const, value: '2580' };
const onFile = async (id: string) => (await adminDb.device.findUniqueOrThrow({ where: { id } })).passcodeKeyVersion !== null;
const age = (id: string, hours: number) =>
  adminDb.$executeRaw`UPDATE devices SET "passcodeSetAt" = "passcodeSetAt" - make_interval(hours => ${hours}::int) WHERE id = ${id}`;

/** A ticket for a new customer + device with a passcode, then closed (Cancelled), then the passcode set again. */
async function closedDeviceWithPasscode(o: OwnerWithShop) {
  const t = await checkInNew(o.agent, { passcode: PIN });
  await o.agent.post(`/api/tickets/${t.id}/cancel`).send({ reason: 'DUPLICATE' }).expect(200);
  await o.agent.patch(`/api/devices/${t.device.id}`).send({ passcode: PIN }).expect(200);
  expect(await onFile(t.device.id)).toBe(true);
  return t;
}

describe('passcode sweep (H1 backstop)', () => {
  it('deletes passcodes of devices without a non-closed ticket in shops with the setting on, only', async () => {
    const swept = await closedDeviceWithPasscode(on);
    await age(swept.device.id, 2);

    const fresh = await closedDeviceWithPasscode(on); // set a minute ago: kept until it is an hour old

    const open = await checkInNew(on.agent, { passcode: PIN }); // open ticket: kept
    await age(open.device.id, 2);

    const reopenedDevice = await closedDeviceWithPasscode(on); // closed, then checked in again: kept
    await checkInExisting(on.agent, reopenedDevice.customer.id, reopenedDevice.device.id);
    await age(reopenedDevice.device.id, 2);

    const noTickets = await on.agent
      .post(`/api/customers/${open.customer.id}/devices`)
      .send({ type: 'LAPTOP', brand: 'Dell', model: 'XPS', passcode: { lockType: 'PASSWORD', value: 'hunter22' } })
      .expect(201);
    await age(noTickets.body.id, 2);

    const settingOff = await closedDeviceWithPasscode(off);
    await age(settingOff.device.id, 2);

    const n = await sweepUnusedPasscodes(appDb); // app role, no shop context
    expect(n).toBeGreaterThanOrEqual(2);
    expect(await onFile(swept.device.id)).toBe(false);
    expect(await onFile(noTickets.body.id)).toBe(false);
    expect(await onFile(fresh.device.id)).toBe(true);
    expect(await onFile(open.device.id)).toBe(true);
    expect(await onFile(reopenedDevice.device.id)).toBe(true);
    expect(await onFile(settingOff.device.id)).toBe(true);

    const events = await adminDb.ticketEvent.findMany({ where: { ticketId: swept.id, type: 'passcode_deleted' }, orderBy: { createdAt: 'asc' } });
    expect(events.at(-1)).toMatchObject({ actorUserId: null, data: { reason: 'closed' } });
    const tl = await on.agent.get(`/api/tickets/${swept.id}/timeline`).expect(200);
    expect(tl.body.items.filter((i: { type: string }) => i.type === 'passcode_deleted').length).toBe(events.length);

    expect(await onFile(swept.device.id)).toBe(false);
  });

  it('is idempotent: a second run deletes nothing more', async () => {
    const before = await adminDb.device.count({ where: { passcodeKeyVersion: { not: null } } });
    await sweepUnusedPasscodes(appDb);
    const after = await adminDb.device.count({ where: { passcodeKeyVersion: { not: null } } });
    expect(after).toBe(before);
  });
});

describe('expired idempotency keys', () => {
  it('deletes keys older than the window, keeps recent ones (never younger than 10 minutes)', async () => {
    const mk = (minutesAgo: number) =>
      adminDb.ticketIdempotencyKey.create({
        data: { shopId: on.shopId, userId: on.userId, key: randomUUID(), createdAt: new Date(Date.now() - minutesAgo * 60_000) },
      });
    const old = await mk(60 * 48);
    const justExpired = await mk(IDEMPOTENCY_WINDOW_MINUTES + 1);
    const live = await mk(IDEMPOTENCY_WINDOW_MINUTES - 5);
    expect(await purgeExpiredIdempotencyKeys(appDb, IDEMPOTENCY_WINDOW_MINUTES)).toBeGreaterThanOrEqual(2);
    const left = await adminDb.ticketIdempotencyKey.findMany({ where: { id: { in: [old.id, justExpired.id, live.id] } } });
    expect(left.map((k) => k.id)).toEqual([live.id]);
    await purgeExpiredIdempotencyKeys(appDb, 0); // clamped to the 10-minute window
    expect(await adminDb.ticketIdempotencyKey.count({ where: { id: live.id } })).toBe(1);
  });
});
