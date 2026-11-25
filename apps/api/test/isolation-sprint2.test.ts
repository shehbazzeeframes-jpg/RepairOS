/**
 * Tenant isolation for the 12 Sprint 2 tables: the scoped client and Postgres RLS both keep shop A from reading
 * or writing shop B's customers, phones, consent, devices, statuses, settings, tickets and ticket children; the
 * composite foreign keys stop a shop A row from pointing at a shop B parent; the SECURITY DEFINER search and erase
 * functions only ever see the transaction's shop.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { eraseCustomer, EraseCustomerError, PrismaClient, searchCustomers, searchDevices, searchTickets, tenantDb } from '@repairos/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerWithShop, type OwnerWithShop } from './fixtures';
import { createRepair, type RepairFixture } from './sprint2-fixtures';
import { createTestApp } from './helpers';

let app: NestExpressApplication;
let adminDb: PrismaClient;
let appDb: PrismaClient;
let a: OwnerWithShop;
let b: OwnerWithShop;
let aData: RepairFixture;
let bData: RepairFixture;

const B_IMEI = '356938035643809';

beforeAll(async () => {
  app = await createTestApp();
  adminDb = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL_TEST });
  appDb = new PrismaClient({ datasourceUrl: process.env.APP_DATABASE_URL_TEST });
  a = await ownerWithShop(app, { shopName: 'Iso2 A' });
  b = await ownerWithShop(app, { shopName: 'Iso2 B', country: 'PK' });
  aData = await createRepair(appDb, a.shopId, a.userId, { firstName: 'Alice', lastName: 'Anders', phone: '+12125550101' });
  bData = await createRepair(appDb, b.shopId, b.userId, {
    firstName: 'Zubair',
    lastName: 'Qadri',
    email: 'zubair.qadri@example.pk',
    phone: '+923001234567',
    imei: B_IMEI,
    serial: 'PKSERIAL99',
  });
});
afterAll(async () => {
  await appDb?.$disconnect();
  await adminDb?.$disconnect();
  await app?.close();
});

/** Prisma delegate name → table, and whether rows have updatedAt (for the raw UPDATE probe). */
const TABLES = [
  { model: 'customer', table: 'customers', update: '"updatedAt" = now()' },
  { model: 'customerPhone', table: 'customer_phones', update: '"updatedAt" = now()' },
  { model: 'customerConsentEvent', table: 'customer_consent_events', update: null },
  { model: 'device', table: 'devices', update: '"updatedAt" = now()' },
  { model: 'ticketStatus', table: 'ticket_statuses', update: '"updatedAt" = now()' },
  { model: 'shopTicketSettings', table: 'shop_ticket_settings', update: '"nextNumber" = "nextNumber" + 100' },
  { model: 'ticket', table: 'tickets', update: '"updatedAt" = now()' },
  { model: 'ticketIssue', table: 'ticket_issues', update: '"position" = 5' },
  { model: 'ticketChecklistItem', table: 'ticket_checklist_items', update: '"updatedAt" = now()' },
  { model: 'ticketAccessory', table: 'ticket_accessories', update: '"code" = \'BOX\'' },
  { model: 'ticketNote', table: 'ticket_notes', update: '"updatedAt" = now()' },
  { model: 'ticketEvent', table: 'ticket_events', update: null },
] as const;

type Delegate = {
  findMany: (args?: unknown) => Promise<{ shopId: string }[]>;
  count: (args?: unknown) => Promise<number>;
  updateMany: (args: unknown) => Promise<{ count: number }>;
  deleteMany: (args: unknown) => Promise<{ count: number }>;
};

describe('scoped client (app role)', () => {
  for (const { model, table } of TABLES) {
    it(`${model}: shop A sees only its own rows and cannot change shop B rows`, async () => {
      const db = tenantDb(appDb, { shopId: a.shopId, userId: a.userId });
      const delegate = (db.client as unknown as Record<string, Delegate>)[model]!;
      const rows = await delegate.findMany();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.shopId === a.shopId)).toBe(true);
      expect(await delegate.findMany({ where: { shopId: b.shopId } })).toEqual([]);
      expect((await delegate.updateMany({ where: { shopId: b.shopId }, data: {} })).count).toBe(0);
      if (table !== 'ticket_events') {
        expect((await delegate.deleteMany({ where: { shopId: b.shopId } })).count).toBe(0);
      }
      // shop B still has its rows
      const [bRows] = await adminDb.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${table}" WHERE "shopId" = $1`, b.shopId);
      expect(bRows!.n).toBeGreaterThan(0);
    });
  }

  it('cross-shop creates are refused by the scoped client', async () => {
    const db = tenantDb(appDb, { shopId: a.shopId, userId: a.userId });
    await expect(
      db.client.customer.create({ data: { shopId: b.shopId, displayName: 'Evil', preferredChannel: 'SMS' } }),
    ).rejects.toThrow(/another shop/);
    await expect(
      db.client.ticketNote.create({ data: { shopId: b.shopId, ticketId: bData.ticketId, authorUserId: a.userId, body: 'x' } }),
    ).rejects.toThrow(/another shop/);
  });
});

describe('row-level security (raw SQL, app role)', () => {
  const inShopA = <T>(fn: (tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]) => Promise<T>) =>
    appDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.shop_id', ${a.shopId}, true)`;
      return fn(tx);
    });

  for (const { table, update } of TABLES) {
    it(`${table}: no rows without a shop context; shop A cannot read or write shop B's rows`, async () => {
      expect(await appDb.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM "${table}"`)).toEqual([]);
      expect(await inShopA((tx) => tx.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM "${table}" WHERE "shopId" = $1`, b.shopId))).toEqual([]);
      if (update) {
        expect(await inShopA((tx) => tx.$executeRawUnsafe(`UPDATE "${table}" SET ${update} WHERE "shopId" = $1`, b.shopId))).toBe(0);
      }
    });
  }

  it('append-only: the app role cannot update or delete timeline events, nor update consent history', async () => {
    await expect(inShopA((tx) => tx.$executeRaw`UPDATE ticket_events SET "data" = '{}' WHERE "shopId" = ${a.shopId}`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(inShopA((tx) => tx.$executeRaw`DELETE FROM ticket_events WHERE "shopId" = ${a.shopId}`)).rejects.toThrow(/permission denied/);
    await expect(inShopA((tx) => tx.$executeRaw`UPDATE customer_consent_events SET note = 'x'`)).rejects.toThrow(/permission denied/);
  });

  it('inserting a shop B row from a shop A context violates the policy', async () => {
    await expect(
      inShopA((tx) => tx.$executeRaw`INSERT INTO customers (id, "shopId", "displayName", "updatedAt") VALUES ('evil', ${b.shopId}, 'Evil', now())`),
    ).rejects.toThrow(/row-level security/);
    await expect(
      inShopA(
        (tx) =>
          tx.$executeRaw`INSERT INTO ticket_events (id, "shopId", "ticketId", type) VALUES ('evil', ${b.shopId}, ${bData.ticketId}, 'created')`,
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("composite foreign keys: a shop A row cannot point at shop B's customer, device, status or ticket", async () => {
    const db = tenantDb(appDb, { shopId: a.shopId, userId: a.userId });
    const fk = /Foreign key constraint|foreign key/i;
    await expect(
      db.client.device.create({ data: { shopId: a.shopId, customerId: bData.customerId, type: 'PHONE', brand: 'X', model: 'Y' } }),
    ).rejects.toThrow(fk);
    await expect(
      db.client.ticketNote.create({ data: { shopId: a.shopId, ticketId: bData.ticketId, authorUserId: a.userId, body: 'x' } }),
    ).rejects.toThrow(fk);
    // A shop A ticket using shop B's status / device of another customer.
    const bStatus = bData.statuses.Received!;
    await expect(
      db.client.ticket.create({
        data: {
          shopId: a.shopId,
          number: 999_001,
          statusId: bStatus.id,
          statusCategory: bStatus.category,
          customerId: aData.customerId,
          deviceId: aData.deviceId,
          currency: 'USD',
          dueAt: new Date(),
        },
      }),
    ).rejects.toThrow(fk);
    await expect(
      db.client.ticket.create({
        data: {
          shopId: a.shopId,
          number: 999_002,
          statusId: aData.statuses.Received!.id,
          statusCategory: 'OPEN',
          customerId: aData.customerId,
          deviceId: bData.deviceId,
          currency: 'USD',
          dueAt: new Date(),
        },
      }),
    ).rejects.toThrow(fk);
    // Assignee must be a member of the shop.
    await expect(
      db.client.ticket.update({ where: { id: aData.ticketId }, data: { assigneeUserId: b.userId } }),
    ).rejects.toThrow(fk);
  });
});

describe('SECURITY DEFINER functions see only the transaction shop', () => {
  it('search returns nothing without a shop context', async () => {
    expect(await appDb.$queryRaw<unknown[]>`SELECT * FROM app_search_customers('Zubair')`).toEqual([]);
    expect(await appDb.$queryRaw<unknown[]>`SELECT * FROM app_search_devices(${B_IMEI})`).toEqual([]);
  });

  it("shop A cannot find shop B's customers, devices or tickets by name, phone, email, IMEI, serial or number", async () => {
    const db = tenantDb(appDb, { shopId: a.shopId, userId: a.userId });
    await db.tx(async (tx) => {
      for (const q of ['Zubair', 'Qadri', 'zubair.qadri@example.pk', '1234567', B_IMEI, 'PKSERIAL99']) {
        expect(await searchCustomers(tx, { q, phoneE164: '+923001234567', includeArchived: true })).toEqual([]);
        expect(await searchDevices(tx, q)).toEqual([]);
        expect(await searchTickets(tx, { shopId: a.shopId, q, ticketNumber: null })).toEqual([]);
      }
      // Same ticket number exists in both shops; only shop A's comes back.
      const hits = await searchTickets(tx, { shopId: a.shopId, q: String(bData.ticketNumber), ticketNumber: bData.ticketNumber });
      expect(hits.map((h) => h.id)).toEqual([aData.ticketId]);
    });
  });

  it("shop A cannot erase shop B's customer", async () => {
    const db = tenantDb(appDb, { shopId: a.shopId, userId: a.userId });
    // B's ticket is open, but from shop A the customer simply does not exist.
    await expect(db.tx((tx) => eraseCustomer(tx, bData.customerId))).rejects.toEqual(new EraseCustomerError('CUSTOMER_NOT_FOUND'));
    const bCustomer = await adminDb.customer.findUniqueOrThrow({ where: { id: bData.customerId } });
    expect(bCustomer.erasedAt).toBeNull();
    expect(bCustomer.firstName).toBe('Zubair');
  });

  it('app_ensure_ticket_defaults cannot seed another shop (RLS on the invoker function)', async () => {
    const db = tenantDb(appDb, { shopId: a.shopId, userId: a.userId });
    const before = await adminDb.ticketStatus.count({ where: { shopId: b.shopId } });
    // shop B already has statuses (RLS hides them, so NOT EXISTS is true) → the insert is refused by WITH CHECK.
    await expect(db.tx((tx) => tx.$executeRaw`SELECT app_ensure_ticket_defaults(${b.shopId})`)).rejects.toThrow(/row-level security/);
    expect(await adminDb.ticketStatus.count({ where: { shopId: b.shopId } })).toBe(before);
  });
});
