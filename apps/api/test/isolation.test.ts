/**
 * Tenant isolation for the Sprint 1 tables (Invitation, BusinessHours, TimeEntry): the scoped client and
 * Postgres RLS both keep shop A from reading or writing shop B. Plus API-level cross-shop checks.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { StaffListItem } from '@repairos/contracts';
import { PrismaClient, tenantDb } from '@repairos/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, type Member, ownerWithShop, type OwnerWithShop } from './fixtures';
import { createTestApp, uniqueEmail } from './helpers';

let app: NestExpressApplication;
let adminDb: PrismaClient;
let appDb: PrismaClient;
let a: OwnerWithShop;
let b: OwnerWithShop;
let bTech: Member;
let bInviteId: string;
let bEntryId: string;

beforeAll(async () => {
  app = await createTestApp();
  adminDb = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL_TEST });
  appDb = new PrismaClient({ datasourceUrl: process.env.APP_DATABASE_URL_TEST });
  a = await ownerWithShop(app, { shopName: 'Iso A' });
  b = await ownerWithShop(app, { shopName: 'Iso B', country: 'PK' });
  bTech = await addMember(app, adminDb, b.shopId, 'TECHNICIAN');
  bInviteId = ((await b.agent.post('/api/staff/invites').send({ email: uniqueEmail(), role: 'TECHNICIAN' }).expect(201)).body as StaffListItem).id;
  await bTech.agent.post('/api/timeclock/clock-in').expect(200);
  bEntryId = (await adminDb.timeEntry.findFirstOrThrow({ where: { shopId: b.shopId } })).id;
});
afterAll(async () => {
  await appDb?.$disconnect();
  await adminDb?.$disconnect();
  await app?.close();
});

const TABLES = [
  { model: 'invitation', table: 'invitations' },
  { model: 'businessHours', table: 'business_hours' },
  { model: 'timeEntry', table: 'time_entries' },
] as const;

describe('scoped client', () => {
  for (const { model } of TABLES) {
    it(`${model}: shop A sees only its own rows and cannot write shop B rows`, async () => {
      const db = tenantDb(appDb, { shopId: a.shopId, userId: a.userId });
      const delegate = (db.client as unknown as Record<string, { findMany: (args?: unknown) => Promise<{ shopId: string }[]>; updateMany: (args: unknown) => Promise<{ count: number }>; deleteMany: (args: unknown) => Promise<{ count: number }> }>)[model]!;
      const rows = await delegate.findMany();
      expect(rows.every((r) => r.shopId === a.shopId)).toBe(true);
      expect(await delegate.findMany({ where: { shopId: b.shopId } })).toEqual([]);
      expect((await delegate.updateMany({ where: { shopId: b.shopId }, data: {} })).count).toBe(0);
      expect((await delegate.deleteMany({ where: { shopId: b.shopId } })).count).toBe(0);
    });
  }

  it('cross-shop creates are refused', async () => {
    const db = tenantDb(appDb, { shopId: a.shopId, userId: a.userId });
    await expect(
      db.client.invitation.create({
        data: { shopId: b.shopId, email: 'x@y.z', role: 'TECHNICIAN', tokenHash: 'h', expiresAt: new Date() },
      }),
    ).rejects.toThrow(/another shop/);
    await expect(db.client.businessHours.create({ data: { shopId: b.shopId, weekday: 0, isOpen: false } })).rejects.toThrow(/another shop/);
    await expect(
      db.client.timeEntry.create({ data: { shopId: b.shopId, userId: a.userId, clockInAt: new Date(), source: 'SELF' } }),
    ).rejects.toThrow(/another shop/);
  });
});

describe('row-level security (raw SQL, app role)', () => {
  for (const { table } of TABLES) {
    it(`${table}: no rows without a shop context; shop A context cannot read or write shop B`, async () => {
      expect(await appDb.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM "${table}"`)).toEqual([]);
      const rows = await appDb.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.shop_id', ${a.shopId}, true)`;
        return tx.$queryRawUnsafe<{ shopId: string }[]>(`SELECT "shopId" FROM "${table}" WHERE "shopId" = $1`, b.shopId);
      });
      expect(rows).toEqual([]);
      const updated = await appDb.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.shop_id', ${a.shopId}, true)`;
        return tx.$executeRawUnsafe(`UPDATE "${table}" SET "updatedAt" = now() WHERE "shopId" = $1`, b.shopId);
      });
      expect(updated).toBe(0);
    });
  }

  it('inserting a shop B row from a shop A context violates the policy', async () => {
    await expect(
      appDb.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.shop_id', ${a.shopId}, true)`;
        await tx.$executeRaw`INSERT INTO time_entries (id, "shopId", "userId", "clockInAt", source, "updatedAt") VALUES ('evil', ${b.shopId}, ${a.userId}, now(), 'SELF', now())`;
      }),
    ).rejects.toThrow(/row-level security/);
    await expect(
      appDb.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.shop_id', ${a.shopId}, true)`;
        await tx.$executeRaw`INSERT INTO invitations (id, "shopId", email, role, "tokenHash", "expiresAt", "updatedAt") VALUES ('evil', ${b.shopId}, 'e@x.y', 'OWNER', 'evil', now(), now())`;
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it('the invite token lookup function returns only (id, shopId) and is the only way in without a context', async () => {
    const rows = await appDb.$queryRaw<{ id: string; shopId: string }[]>`SELECT * FROM app_invitation_by_token_hash('nope')`;
    expect(rows).toEqual([]);
    const hash = (await adminDb.invitation.findUniqueOrThrow({ where: { id: bInviteId } })).tokenHash;
    const found = await appDb.$queryRaw<Record<string, unknown>[]>`SELECT * FROM app_invitation_by_token_hash(${hash})`;
    expect(found).toEqual([{ id: bInviteId, shopId: b.shopId }]);
    expect(await appDb.invitation.count()).toBe(0);
  });
});

describe('API cross-shop checks', () => {
  it("shop A's owner cannot act on shop B's staff, invites, time entries or audit events", async () => {
    expect((await a.agent.post(`/api/staff/${bTech.membershipId}/deactivate`)).status).toBe(404);
    expect((await a.agent.patch(`/api/staff/${bTech.membershipId}/role`).send({ role: 'MANAGER' })).status).toBe(404);
    expect((await a.agent.post(`/api/staff/invites/${bInviteId}/revoke`)).status).toBe(404);
    expect((await a.agent.post(`/api/staff/invites/${bInviteId}/link`)).status).toBe(404);
    expect((await a.agent.patch(`/api/time-entries/${bEntryId}`).send({ clockOutAt: new Date().toISOString(), reason: 'nope' })).status).toBe(404);
    expect((await a.agent.delete(`/api/time-entries/${bEntryId}`).send({ reason: 'nope' })).status).toBe(404);
    const add = await a.agent
      .post('/api/time-entries')
      .send({ userId: bTech.userId, clockInAt: '2026-11-01T10:00:00Z', clockOutAt: '2026-11-01T11:00:00Z', reason: 'Cross shop' });
    expect(add.status).toBe(404);
    const staff = (await a.agent.get('/api/staff?status=ACTIVE,INVITED,DEACTIVATED').expect(200)).body as { items: StaffListItem[] };
    expect(staff.items.map((i) => i.userId ?? i.email)).toEqual([a.userId]);
    const ts = (await a.agent.get('/api/timesheets?from=2026-01-01&to=2026-03-01').expect(200)).body;
    expect(ts.staff).toEqual([]);
    // shop B is untouched
    expect((await adminDb.membership.findUniqueOrThrow({ where: { id: bTech.membershipId } })).status).toBe('ACTIVE');
    expect((await adminDb.invitation.findUniqueOrThrow({ where: { id: bInviteId } })).status).toBe('PENDING');
    expect((await adminDb.timeEntry.findUniqueOrThrow({ where: { id: bEntryId } })).clockOutAt).toBeNull();
  });

  it("shop B's hours and tax rates are not visible or editable from shop A", async () => {
    const bRate = await adminDb.taxRate.findFirstOrThrow({ where: { shopId: b.shopId } });
    expect((await a.agent.patch(`/api/shop/tax-rates/${bRate.id}`).send({ name: 'Hacked' })).status).toBe(404);
    expect((await a.agent.post(`/api/shop/tax-rates/${bRate.id}/archive`)).status).toBe(404);
    const rates = (await a.agent.get('/api/shop/tax-rates?includeArchived=true').expect(200)).body.items as { id: string }[];
    expect(rates.map((r) => r.id)).not.toContain(bRate.id);
    const days = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, isOpen: false, opensAt: null, closesAt: null }));
    await a.agent.put('/api/shop/hours').send({ days }).expect(200);
    expect(await adminDb.businessHours.count({ where: { shopId: b.shopId, isOpen: true } })).toBe(6);
  });
});
