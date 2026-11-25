/**
 * Story §6: every Sprint 1 action writes its audit event in the same transaction as the change (one test per
 * action), and the read-only viewer API (list with filters + cursor, detail).
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  AUDIT_ACTION_META,
  SPRINT1_AUDIT_ACTIONS,
  AuditEventDetail,
  AuditEventListResponse,
  type StaffListItem,
  type TaxRate,
} from '@repairos/contracts';
import { PrismaClient } from '@repairos/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, ageInviteSends, auditOf, inviteTokenFor, ownerWithShop, type OwnerWithShop } from './fixtures';
import { agentFor, createTestApp, signUp, uniqueEmail } from './helpers';

let app: NestExpressApplication;
let adminDb: PrismaClient;
let owner: OwnerWithShop;
const today = new Date().toISOString().slice(0, 10);
const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const range = `from=${new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)}&to=${tomorrow}`;

beforeAll(async () => {
  app = await createTestApp();
  adminDb = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL_TEST });

  // One shop, every Sprint 1 action once.
  owner = await ownerWithShop(app, { name: 'Audit Owner', shopName: 'Audit Shop' }); // shop.created
  const a = owner.agent;
  await a.patch('/api/shop').send({ name: 'Audit Shop 2' }).expect(200); // shop.updated
  await a.patch('/api/shop/tax-settings').send({ pricesIncludeTax: true }).expect(200); // shop.tax_settings_updated
  const days = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, isOpen: true, opensAt: '09:00', closesAt: '17:00' }));
  await a.put('/api/shop/hours').send({ days }).expect(200); // shop.hours_updated
  const rate = (await a.post('/api/shop/tax-rates').send({ name: 'City', rateMilliPct: 4500, appliesTo: 'all' }).expect(201)).body as TaxRate; // tax_rate.created
  await a.patch(`/api/shop/tax-rates/${rate.id}`).send({ rateMilliPct: 4875 }).expect(200); // tax_rate.updated
  await a.post(`/api/shop/tax-rates/${rate.id}/archive`).expect(200); // tax_rate.archived
  await a.post(`/api/shop/tax-rates/${rate.id}/restore`).expect(200); // tax_rate.restored
  await a.patch(`/api/shop/tax-rates/${rate.id}`).send({ isDefaultGoods: true }).expect(200); // tax_rate.default_changed

  const email = uniqueEmail('audit');
  const inv = (await a.post('/api/staff/invites').send({ email, role: 'TECHNICIAN' }).expect(201)).body as StaffListItem; // invite.created
  await a.post(`/api/staff/invites/${inv.id}/resend`).expect(200); // invite.resent
  await ageInviteSends(adminDb, inv.id);
  await a.post(`/api/staff/invites/${inv.id}/link`).expect(200); // invite.link_copied
  const other = (await a.post('/api/staff/invites').send({ email: uniqueEmail(), role: 'TECHNICIAN' }).expect(201)).body as StaffListItem;
  await a.post(`/api/staff/invites/${other.id}/revoke`).expect(204); // invite.revoked
  await ageInviteSends(adminDb, inv.id);
  await a.post(`/api/staff/invites/${inv.id}/resend`).expect(200);
  const joiner = agentFor(app);
  await signUp(joiner, 'Sam Lee', email);
  await joiner.post(`/api/invites/${await inviteTokenFor(email)}/accept`).expect(200); // invite.accepted

  const sam = await adminDb.membership.findFirstOrThrow({ where: { shopId: owner.shopId, user: { email } } });
  await a.patch(`/api/staff/${sam.id}/role`).send({ role: 'FRONT_DESK' }).expect(200); // member.role_changed
  await joiner.post('/api/timeclock/clock-in').expect(200);
  await a.post(`/api/staff/${sam.id}/deactivate`).expect(200); // member.deactivated + time_entry.auto_closed
  await a.post(`/api/staff/${sam.id}/reactivate`).expect(200); // member.reactivated

  const entry = (
    await a
      .post('/api/time-entries')
      .send({ userId: sam.userId, clockInAt: '2026-11-02T14:00:00Z', clockOutAt: '2026-11-02T15:00:00Z', reason: 'Missed punch' })
      .expect(201)
  ).body as { id: string }; // time_entry.created
  await a.patch(`/api/time-entries/${entry.id}`).send({ clockOutAt: '2026-11-02T16:00:00Z', reason: 'Stayed late' }).expect(200); // time_entry.updated
  await a.delete(`/api/time-entries/${entry.id}`).send({ reason: 'Duplicate' }).expect(204); // time_entry.deleted
  await a.get('/api/timesheets/export.csv?from=2026-11-01&to=2026-11-07').expect(200); // timesheet.exported
});
afterAll(async () => {
  await adminDb?.$disconnect();
  await app?.close();
});

describe('every Sprint 1 action writes an audit event', () => {
  it('covers all 22 Sprint 1 actions', () => {
    expect(SPRINT1_AUDIT_ACTIONS).toHaveLength(22);
  });

  it.each(SPRINT1_AUDIT_ACTIONS.map((a) => [a]))('%s', async (action) => {
    const events = await auditOf(adminDb, owner.shopId, action);
    expect(events.length, action).toBeGreaterThan(0);
    const e = events[0]!;
    expect(e.entityType).toBe(AUDIT_ACTION_META[action].entityType);
    expect(e.actorUserId).not.toBeNull();
    expect(e.before !== null || e.after !== null).toBe(true);
    // never tokens, hashes or links
    expect(JSON.stringify(e)).not.toMatch(/tokenHash|\/invite\/|[A-Za-z0-9_-]{43}/);
  });

  it('a failed change writes no audit event (same transaction)', async () => {
    const before = await adminDb.auditLog.count({ where: { shopId: owner.shopId } });
    const db = (await import('../src/prisma/prisma.service')).PrismaService;
    const prisma = app.get(db);
    const { writeAudit } = await import('../src/common/audit');
    await expect(
      prisma.forShop({ shopId: owner.shopId, userId: owner.userId }).tx(async (tx) => {
        await tx.shop.update({ where: { id: owner.shopId }, data: { name: 'Rolled back' } });
        await writeAudit(tx, { shopId: owner.shopId, actorUserId: owner.userId, action: 'shop.updated', entityId: owner.shopId, after: { name: 'Rolled back' } });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await adminDb.auditLog.count({ where: { shopId: owner.shopId } })).toBe(before);
    // and a rejected API call (LAST_TAX_RATE / validation) leaves no event either
    const archived = await owner.agent.post('/api/shop/tax-rates/does-not-exist/archive');
    expect(archived.status).toBe(404);
    expect(await adminDb.auditLog.count({ where: { shopId: owner.shopId } })).toBe(before);
  });
});

describe('audit viewer API (AU1)', () => {
  it('lists newest first with actor names, entity labels, filters and cursor pagination', async () => {
    const page = AuditEventListResponse.parse((await owner.agent.get(`/api/audit-events?${range}`).expect(200)).body);
    expect(page.items.length).toBeGreaterThanOrEqual(22);
    const times = page.items.map((i) => i.createdAt);
    expect([...times].sort().reverse()).toEqual(times);
    expect(page.nextCursor).toBeNull();

    const created = page.items.find((i) => i.action === 'shop.created')!;
    expect(created).toMatchObject({ actor: { userId: owner.userId, name: 'Audit Owner' }, entityType: 'Shop', entityLabel: 'Audit Shop 2' });
    expect(page.items.find((i) => i.action === 'member.role_changed')).toMatchObject({ entityLabel: 'Sam Lee' });
    expect(page.items.find((i) => i.action === 'tax_rate.created')).toMatchObject({ entityLabel: 'City' });
    expect(page.items.find((i) => i.action === 'invite.revoked')?.entityLabel).toMatch(/@test\.repairos\.dev$/);
    expect(page.items.find((i) => i.action === 'time_entry.deleted')).toMatchObject({ entityLabel: 'Sam Lee' });
    expect(page.items.find((i) => i.action === 'invite.accepted')?.actor?.name).toBe('Sam Lee');

    // pagination: 5 per page walks the whole list without gaps or repeats
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = AuditEventListResponse.parse(
        (await owner.agent.get(`/api/audit-events?${range}&limit=5${cursor ? `&cursor=${cursor}` : ''}`).expect(200)).body,
      );
      seen.push(...res.items.map((i) => i.id));
      cursor = res.nextCursor;
    } while (cursor);
    expect(seen).toEqual(page.items.map((i) => i.id));

    // filters
    const tax = AuditEventListResponse.parse((await owner.agent.get(`/api/audit-events?${range}&actionGroup=tax`).expect(200)).body);
    expect(new Set(tax.items.map((i) => AUDIT_ACTION_META[i.action].group))).toEqual(new Set(['tax']));
    const one = AuditEventListResponse.parse((await owner.agent.get(`/api/audit-events?${range}&action=invite.resent`).expect(200)).body);
    expect(one.items.map((i) => i.action)).toEqual(['invite.resent', 'invite.resent']);
    const none = AuditEventListResponse.parse((await owner.agent.get(`/api/audit-events?${range}&action=invite.resent&actionGroup=tax`).expect(200)).body);
    expect(none.items).toEqual([]);
    const byJoiner = AuditEventListResponse.parse(
      (await owner.agent.get(`/api/audit-events?${range}&userId=${page.items.find((i) => i.action === 'invite.accepted')!.actor!.userId}`).expect(200)).body,
    );
    expect(byJoiner.items.map((i) => i.action)).toEqual(['invite.accepted']);
    const past = AuditEventListResponse.parse((await owner.agent.get('/api/audit-events?from=2020-01-01&to=2020-01-07').expect(200)).body);
    expect(past.items).toEqual([]);

    expect((await owner.agent.get('/api/audit-events?from=2025-01-01&to=2026-01-02')).status).toBe(400); // > 1 year
    expect((await owner.agent.get(`/api/audit-events?${range}&cursor=garbage`)).status).toBe(400);
    expect((await owner.agent.get(`/api/audit-events?${range}&action=nope`)).status).toBe(400);
    expect(today).toBeTruthy();
  });

  it('detail returns before/after (created = after only, deleted = before only); 404 for unknown', async () => {
    const page = AuditEventListResponse.parse((await owner.agent.get(`/api/audit-events?${range}`).expect(200)).body);
    const roleChange = AuditEventDetail.parse(
      (await owner.agent.get(`/api/audit-events/${page.items.find((i) => i.action === 'member.role_changed')!.id}`).expect(200)).body,
    );
    expect(roleChange).toMatchObject({ before: { role: 'TECHNICIAN' }, after: { role: 'FRONT_DESK' } });
    const created = AuditEventDetail.parse(
      (await owner.agent.get(`/api/audit-events/${page.items.find((i) => i.action === 'tax_rate.created')!.id}`).expect(200)).body,
    );
    expect(created.before).toBeNull();
    expect(created.after).toEqual({ name: 'City', rateMilliPct: 4500, appliesTo: 'all' });
    const deleted = AuditEventDetail.parse(
      (await owner.agent.get(`/api/audit-events/${page.items.find((i) => i.action === 'time_entry.deleted')!.id}`).expect(200)).body,
    );
    expect(deleted.after).toBeNull();
    expect(deleted.before).toMatchObject({ reason: 'Duplicate' });
    expect((await owner.agent.get('/api/audit-events/nope')).status).toBe(404);
  });

  it('managers see owners\' events; other shops\' events are invisible', async () => {
    const manager = await addMember(app, adminDb, owner.shopId, 'MANAGER');
    const page = AuditEventListResponse.parse((await manager.agent.get(`/api/audit-events?${range}`).expect(200)).body);
    expect(page.items.some((i) => i.actor?.userId === owner.userId)).toBe(true);

    const other = await ownerWithShop(app);
    const theirs = AuditEventListResponse.parse((await other.agent.get(`/api/audit-events?${range}`).expect(200)).body);
    expect(theirs.items.map((i) => i.action)).toEqual(['shop.created']);
    expect((await other.agent.get(`/api/audit-events/${page.items[0]!.id}`)).status).toBe(404);
  });
});
