/** Global search (§7 GS1): grouped results, permissions per group, exact-match jump for number / IMEI / serial. */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { GlobalSearchResponse } from '@repairos/contracts';
import { PrismaClient } from '@repairos/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerWithShop, type OwnerWithShop } from './fixtures';
import { createTestApp } from './helpers';
import { checkInNew, imei } from './s2';

let app: NestExpressApplication;
let adminDb: PrismaClient;
let owner: OwnerWithShop;

beforeAll(async () => {
  app = await createTestApp();
  adminDb = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL_TEST });
  owner = await ownerWithShop(app, { shopName: 'Search Shop' });
});
afterAll(async () => {
  await adminDb?.$disconnect();
  await app?.close();
});

const search = async (q: string) => GlobalSearchResponse.parse((await owner.agent.get(`/api/search?q=${encodeURIComponent(q)}`).expect(200)).body);

describe('global search', () => {
  it('groups tickets, customers and devices; exact matches jump', async () => {
    const code = imei(31337);
    const t = await checkInNew(owner.agent, { firstName: 'Nadia', lastName: 'Rahman', phone: '+12122007788', imei: code });
    await owner.agent.patch(`/api/devices/${t.device.id}`).send({ serial: 'C02XK1ABJG5H' }).expect(200);

    const byName = await search('rahman nadia');
    expect(byName.tickets.map((x) => x.id)).toEqual([t.id]);
    expect(byName.customers.map((c) => c.id)).toEqual([t.customer.id]);
    expect(byName.tickets[0]).toMatchObject({ numberLabel: t.numberLabel, customerDisplayName: 'Nadia Rahman', deviceLabel: 'Apple iPhone 13', status: { name: 'Received' } });
    expect(byName.exactMatch).toBeNull();

    const byNumber = await search(t.numberLabel.toLowerCase());
    expect(byNumber.exactMatch).toEqual({ kind: 'ticket', ticketId: t.id });
    expect((await search(`#${t.number}`)).exactMatch).toEqual({ kind: 'ticket', ticketId: t.id });

    const byImei = await search(code);
    expect(byImei.devices[0]).toMatchObject({ id: t.device.id, imei: code, customer: { id: t.customer.id }, latestTicket: { id: t.id } });
    expect(byImei.exactMatch).toEqual({ kind: 'device', deviceId: t.device.id, customerId: t.customer.id, ticketId: t.id });
    expect((await search('c02xk1abjg5h')).exactMatch).toMatchObject({ kind: 'device', deviceId: t.device.id });
    const partial = await search(code.slice(-6));
    expect(partial.devices.map((d) => d.id)).toEqual([t.device.id]);
    expect(partial.exactMatch).toBeNull();

    const byPhone = await search('(212) 200-7788');
    expect(byPhone.customers.map((c) => c.id)).toEqual([t.customer.id]);
    expect(byPhone.tickets.map((x) => x.id)).toEqual([t.id]);

    expect((await owner.agent.get('/api/search?q=a')).status).toBe(400);
    expect((await owner.agent.get('/api/search?q=nadia&limit=11')).status).toBe(400);
  });
});
