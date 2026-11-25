/** Story §2 (staff management) and Risk #1 (deactivation), against real Postgres. */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ApiError, MeResponse, Shop, StaffListItem, StaffListResponse, TimeclockStatus } from '@repairos/contracts';
import { PrismaClient } from '@repairos/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, auditOf, lastEmailTo, ownerWithShop, type OwnerWithShop } from './fixtures';
import { createTestApp, uniqueEmail } from './helpers';

let app: NestExpressApplication;
let adminDb: PrismaClient;

beforeAll(async () => {
  app = await createTestApp();
  adminDb = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL_TEST });
});
afterAll(async () => {
  await adminDb?.$disconnect();
  await app?.close();
});

const list = async (o: OwnerWithShop, status?: string) =>
  StaffListResponse.parse((await o.agent.get(`/api/staff${status ? `?status=${status}` : ''}`).expect(200)).body);

describe('staff list (S1)', () => {
  it('lists members and invites with status, clock state and seats, sorted and filtered', async () => {
    const owner = await ownerWithShop(app, { name: 'Zed Owner' });
    const tech = await addMember(app, adminDb, owner.shopId, 'TECHNICIAN', 'Amy Tech');
    const manager = await addMember(app, adminDb, owner.shopId, 'MANAGER', 'Mo Manager');
    const fd = await addMember(app, adminDb, owner.shopId, 'FRONT_DESK', 'Fay Desk');
    await tech.agent.post('/api/timeclock/clock-in').expect(200);
    await owner.agent.post('/api/staff/invites').send({ email: 'b-invite@test.repairos.dev', role: 'TECHNICIAN' }).expect(201);
    await owner.agent.post(`/api/staff/${fd.membershipId}/deactivate`).expect(200);

    const res = await list(owner);
    expect(res.seats).toEqual({ used: 4, limit: 5 }); // owner, manager, tech + 1 pending invite
    expect(res.items.map((i) => [i.status, i.name ?? i.email])).toEqual([
      ['ACTIVE', 'Zed Owner'],
      ['ACTIVE', 'Mo Manager'],
      ['ACTIVE', 'Amy Tech'],
      ['INVITED', 'b-invite@test.repairos.dev'],
    ]);
    const self = res.items[0]!;
    expect(self).toMatchObject({ kind: 'MEMBER', isSelf: true, lastClockInAt: null, clockedIn: false });
    const techRow = res.items.find((i) => i.userId === tech.userId)!;
    expect(techRow).toMatchObject({ clockedIn: true, isSelf: false, role: 'TECHNICIAN' });
    expect(techRow.lastClockInAt).not.toBeNull();
    const invite = res.items[3]!;
    expect(invite).toMatchObject({ kind: 'INVITE', userId: null, name: null, inviteExpired: false, inviteEmailStatus: 'SENT' });

    const all = await list(owner, 'ACTIVE,INVITED,DEACTIVATED');
    expect(all.items.at(-1)).toMatchObject({ status: 'DEACTIVATED', name: 'Fay Desk' });
    expect(all.seats.used).toBe(4);
    const onlyDeactivated = await list(owner, 'DEACTIVATED');
    expect(onlyDeactivated.items.map((i) => i.userId)).toEqual([fd.userId]);
    expect((await owner.agent.get('/api/staff?status=NOPE')).status).toBe(400);
    expect(manager.userId).toBeTruthy();
  });
});

describe('invites (S2, S3)', () => {
  let owner: OwnerWithShop;
  beforeEach(async () => {
    owner = await ownerWithShop(app);
  });

  it('creates an invite: 201 row, email queued+sent, audit without the token', async () => {
    const email = uniqueEmail('Invitee').toUpperCase();
    const res = await owner.agent.post('/api/staff/invites').send({ email: `  ${email} `, role: 'FRONT_DESK' });
    expect(res.status).toBe(201);
    const row = StaffListItem.parse(res.body);
    expect(row).toMatchObject({ kind: 'INVITE', status: 'INVITED', email: email.toLowerCase(), role: 'FRONT_DESK' });
    expect(Date.parse(row.inviteExpiresAt!) - Date.now()).toBeGreaterThan(6.9 * 24 * 3600 * 1000);

    const mail = await lastEmailTo(email.toLowerCase());
    expect(mail?.subject).toBe(`Olivia Owner invited you to join Test Shop on RepairOS`);
    const [audit] = await auditOf(adminDb, owner.shopId, 'invite.created');
    expect(audit).toMatchObject({ entityType: 'Invitation', entityId: row.id, actorUserId: owner.userId });
    expect(audit!.after).toEqual({ email: email.toLowerCase(), role: 'FRONT_DESK', expiresAt: row.inviteExpiresAt });
    const token = mail!.text.match(/invite\/([\w-]{43})/)![1]!;
    expect(JSON.stringify(await auditOf(adminDb, owner.shopId))).not.toContain(token);
    const stored = await adminDb.invitation.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.tokenHash).not.toContain(token);
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a Manager may only invite Front desk and Technicians (403 otherwise)', async () => {
    const manager = await addMember(app, adminDb, owner.shopId, 'MANAGER');
    for (const role of ['OWNER', 'MANAGER']) {
      const res = await manager.agent.post('/api/staff/invites').send({ email: uniqueEmail(), role });
      expect(res.status, role).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    }
    await manager.agent.post('/api/staff/invites').send({ email: uniqueEmail(), role: 'TECHNICIAN' }).expect(201);
  });

  it('ALREADY_MEMBER (incl. own email), MEMBER_DEACTIVATED, INVITE_PENDING', async () => {
    const tech = await addMember(app, adminDb, owner.shopId, 'TECHNICIAN', 'Sam Lee');
    let res = await owner.agent.post('/api/staff/invites').send({ email: tech.email.toUpperCase(), role: 'TECHNICIAN' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'ALREADY_MEMBER', message: `${tech.email} is already on your team.` });
    res = await owner.agent.post('/api/staff/invites').send({ email: owner.email, role: 'TECHNICIAN' });
    expect(res.body.code).toBe('ALREADY_MEMBER');

    await owner.agent.post(`/api/staff/${tech.membershipId}/deactivate`).expect(200);
    res = await owner.agent.post('/api/staff/invites').send({ email: tech.email, role: 'TECHNICIAN' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'MEMBER_DEACTIVATED', message: 'Sam Lee was deactivated. Reactivate them instead.' });

    const email = uniqueEmail();
    await owner.agent.post('/api/staff/invites').send({ email, role: 'TECHNICIAN' }).expect(201);
    res = await owner.agent.post('/api/staff/invites').send({ email, role: 'FRONT_DESK' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'INVITE_PENDING', message: `An invite was already sent to ${email}.` });
  });

  it('two concurrent invites for the same email: one wins, the other gets INVITE_PENDING', async () => {
    const email = uniqueEmail();
    const results = await Promise.all([1, 2].map(() => owner.agent.post('/api/staff/invites').send({ email, role: 'TECHNICIAN' })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe('INVITE_PENDING');
  });

  it('seat limit: 403 SEAT_LIMIT_REACHED at 5; revoked and expired invites free their seat', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await owner.agent.post('/api/staff/invites').send({ email: uniqueEmail(), role: 'TECHNICIAN' }).expect(201)).body.id);
    expect((await list(owner)).seats.used).toBe(5);
    const blocked = await owner.agent.post('/api/staff/invites').send({ email: uniqueEmail(), role: 'TECHNICIAN' });
    expect(blocked.status).toBe(403);
    expect(ApiError.parse(blocked.body)).toMatchObject({
      code: 'SEAT_LIMIT_REACHED',
      message: 'Your plan includes 5 users. Extra users are $5/month; billing arrives later.',
    });

    await owner.agent.post(`/api/staff/invites/${ids[0]}/revoke`).expect(204);
    expect((await list(owner)).seats.used).toBe(4);
    // Expire another: it no longer holds a seat, and still shows (as expired) in the list.
    await adminDb.invitation.update({ where: { id: ids[1] }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const after = await list(owner);
    expect(after.seats.used).toBe(3);
    expect(after.items.find((i) => i.id === ids[1])).toMatchObject({ inviteExpired: true, status: 'INVITED' });
    expect(after.items.find((i) => i.id === ids[0])).toBeUndefined();
  });

  it('concurrency: 5 parallel invites with one seat left create exactly one', async () => {
    for (let i = 0; i < 3; i++) await owner.agent.post('/api/staff/invites').send({ email: uniqueEmail(), role: 'TECHNICIAN' }).expect(201);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => owner.agent.post('/api/staff/invites').send({ email: uniqueEmail(), role: 'TECHNICIAN' })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 403 && r.body.code === 'SEAT_LIMIT_REACHED')).toHaveLength(4);
    expect((await list(owner)).seats.used).toBe(5);
  });

  it('resend rotates the token, resets expiry and re-checks seats when expired; revoke rules', async () => {
    const email = uniqueEmail();
    const created = StaffListItem.parse((await owner.agent.post('/api/staff/invites').send({ email, role: 'TECHNICIAN' }).expect(201)).body);
    const firstMail = await lastEmailTo(email);
    await adminDb.invitation.update({ where: { id: created.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    // fill the shop so the expired invite cannot come back
    for (let i = 0; i < 4; i++) await owner.agent.post('/api/staff/invites').send({ email: uniqueEmail(), role: 'TECHNICIAN' }).expect(201);
    const blocked = await owner.agent.post(`/api/staff/invites/${created.id}/resend`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('SEAT_LIMIT_REACHED');

    const someone = (await list(owner)).items.find((i) => i.kind === 'INVITE' && i.id !== created.id)!;
    await owner.agent.post(`/api/staff/invites/${someone.id}/revoke`).expect(204);
    const resent = StaffListItem.parse((await owner.agent.post(`/api/staff/invites/${created.id}/resend`).expect(200)).body);
    expect(resent.inviteExpired).toBe(false);
    const mails = (await import('./fixtures')).emailsTo(email);
    const [newest] = await mails;
    expect(newest!.id).not.toBe(firstMail!.id);
    expect(newest!.text.match(/invite\/([\w-]{43})/)![1]).not.toBe(firstMail!.text.match(/invite\/([\w-]{43})/)![1]);
    const stored = await adminDb.invitation.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored).toMatchObject({ sendCount: 2, emailStatus: 'SENT', linkCopiedAt: null });

    // 1/min rate limit
    const tooSoon = await owner.agent.post(`/api/staff/invites/${created.id}/resend`);
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.body.code).toBe('RATE_LIMITED');

    await owner.agent.post(`/api/staff/invites/${created.id}/revoke`).expect(204);
    for (const action of ['revoke', 'resend', 'link']) {
      const res = await owner.agent.post(`/api/staff/invites/${created.id}/${action}`);
      expect(res.status, action).toBe(409);
      expect(res.body.code).toBe('INVITE_NOT_PENDING');
    }
    expect((await owner.agent.post('/api/staff/invites/nope/revoke')).status).toBe(404);
  });

  it('a Manager cannot resend/revoke/copy an invite for an Owner or Manager role', async () => {
    const inv = (await owner.agent.post('/api/staff/invites').send({ email: uniqueEmail(), role: 'MANAGER' }).expect(201)).body as StaffListItem;
    const manager = await addMember(app, adminDb, owner.shopId, 'MANAGER');
    for (const action of ['resend', 'revoke', 'link']) {
      expect((await manager.agent.post(`/api/staff/invites/${inv.id}/${action}`)).status, action).toBe(403);
    }
  });

  it('invites created per shop per day are capped at 20 (429)', async () => {
    const shopId = owner.shopId;
    await adminDb.invitation.createMany({
      data: Array.from({ length: 20 }, (_, i) => ({
        shopId,
        email: `bulk${i}-${shopId}@test.repairos.dev`,
        role: 'TECHNICIAN' as const,
        tokenHash: `bulk-${shopId}-${i}`,
        status: 'REVOKED' as const,
        expiresAt: new Date(Date.now() + 1000),
      })),
    });
    const res = await owner.agent.post('/api/staff/invites').send({ email: uniqueEmail(), role: 'TECHNICIAN' });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('RATE_LIMITED');
  });
});

describe('change role (S4)', () => {
  it('owner changes roles; manager limits; not self; same role no-op; audit before/after', async () => {
    const owner = await ownerWithShop(app);
    const manager = await addMember(app, adminDb, owner.shopId, 'MANAGER');
    const tech = await addMember(app, adminDb, owner.shopId, 'TECHNICIAN');
    const other = await addMember(app, adminDb, owner.shopId, 'MANAGER');

    const changed = StaffListItem.parse((await owner.agent.patch(`/api/staff/${tech.membershipId}/role`).send({ role: 'FRONT_DESK' }).expect(200)).body);
    expect(changed).toMatchObject({ role: 'FRONT_DESK', userId: tech.userId });
    const [audit] = await auditOf(adminDb, owner.shopId, 'member.role_changed');
    expect(audit).toMatchObject({ entityType: 'Membership', entityId: tech.membershipId, before: { role: 'TECHNICIAN' }, after: { role: 'FRONT_DESK' } });

    // same role → 200 no-op, no new audit
    await owner.agent.patch(`/api/staff/${tech.membershipId}/role`).send({ role: 'FRONT_DESK' }).expect(200);
    expect(await auditOf(adminDb, owner.shopId, 'member.role_changed')).toHaveLength(1);

    // Manager: only FD ↔ T
    await manager.agent.patch(`/api/staff/${tech.membershipId}/role`).send({ role: 'TECHNICIAN' }).expect(200);
    for (const [target, role] of [
      [tech.membershipId, 'MANAGER'],
      [other.membershipId, 'TECHNICIAN'],
      [tech.membershipId, 'OWNER'],
    ] as const) {
      const res = await manager.agent.patch(`/api/staff/${target}/role`).send({ role });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    }
    // not self
    const self = await manager.agent.patch(`/api/staff/${manager.membershipId}/role`).send({ role: 'TECHNICIAN' });
    expect(self.status).toBe(403);
    expect(self.body).toMatchObject({ code: 'CANNOT_CHANGE_SELF', message: "You can't change your own role." });
    const ownerSelf = await owner.agent.get('/api/staff').expect(200);
    const ownRow = (ownerSelf.body as StaffListResponse).items.find((i) => i.isSelf)!;
    expect((await owner.agent.patch(`/api/staff/${ownRow.id}/role`).send({ role: 'MANAGER' })).body.code).toBe('CANNOT_CHANGE_SELF');
    expect((await owner.agent.patch('/api/staff/nope/role').send({ role: 'MANAGER' })).status).toBe(404);
    expect((await owner.agent.patch(`/api/staff/${tech.membershipId}/role`).send({ role: 'BOSS' })).status).toBe(400);
  });

  it('LAST_OWNER: concurrent owners demoting each other leaves exactly one owner', async () => {
    const a = await ownerWithShop(app);
    const b = await addMember(app, adminDb, a.shopId, 'OWNER');
    const aMembership = (await adminDb.membership.findFirstOrThrow({ where: { shopId: a.shopId, userId: a.userId } })).id;
    const [r1, r2] = await Promise.all([
      a.agent.patch(`/api/staff/${b.membershipId}/role`).send({ role: 'MANAGER' }),
      b.agent.patch(`/api/staff/${aMembership}/role`).send({ role: 'MANAGER' }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses[0]).toBe(200);
    expect([403, 409]).toContain(statuses[1]); // 409 LAST_OWNER, or 403 when the loser was already demoted
    expect(await adminDb.membership.count({ where: { shopId: a.shopId, role: 'OWNER', status: 'ACTIVE' } })).toBe(1);

  });
});

describe('deactivate / reactivate (S5) and Risk #1', () => {
  it('deactivation closes the open entry, is audited, and rejects the very next request', async () => {
    const owner = await ownerWithShop(app, { shopName: 'Main Street Fix' });
    const tech = await addMember(app, adminDb, owner.shopId, 'TECHNICIAN', 'Tia Tech');
    await tech.agent.post('/api/timeclock/clock-in').expect(200);
    expect((await tech.agent.get('/api/timeclock/me')).status).toBe(200);

    const res = StaffListItem.parse((await owner.agent.post(`/api/staff/${tech.membershipId}/deactivate`).expect(200)).body);
    expect(res).toMatchObject({ status: 'DEACTIVATED', clockedIn: false });
    expect(res.deactivatedAt).not.toBeNull();

    // the very next request for that shop is rejected
    const next = await tech.agent.get('/api/timeclock/me');
    expect(next.status).toBe(403);
    expect(next.body.message).toBe('You no longer have access to this shop');
    expect((await tech.agent.post('/api/timeclock/clock-in')).status).toBe(403);

    // D8: open entry closed at deactivation, marked, audited
    const entry = await adminDb.timeEntry.findFirstOrThrow({ where: { shopId: owner.shopId, userId: tech.userId } });
    expect(entry.clockOutAt).not.toBeNull();
    expect(entry.closedReason).toBe('DEACTIVATED');
    expect((await auditOf(adminDb, owner.shopId, 'time_entry.auto_closed'))[0]).toMatchObject({
      entityId: entry.id,
      after: { closedReason: 'DEACTIVATED' },
    });
    expect((await auditOf(adminDb, owner.shopId, 'member.deactivated'))[0]).toMatchObject({
      entityId: tech.membershipId,
      before: { status: 'ACTIVE' },
      after: { status: 'DEACTIVATED' },
    });

    // only membership deactivated → /me: no shop, accessRemoved (not onboarding)
    const me = MeResponse.parse((await tech.agent.get('/api/me').expect(200)).body);
    expect(me).toMatchObject({
      activeShop: null,
      role: null,
      permissions: [],
      memberships: [],
      accessRemoved: { shopId: owner.shopId, shopName: 'Main Street Fix' },
    });
    // a fresh sign-in does not fall back to the deactivated membership either
    const again = (await import('./helpers')).agentFor(app);
    await again.post('/api/auth/sign-in/email').send({ email: tech.email, password: 'Password123!' }).expect(200);
    const me2 = MeResponse.parse((await again.get('/api/me').expect(200)).body);
    expect(me2.activeShop).toBeNull();
    expect(me2.accessRemoved?.shopId).toBe(owner.shopId);
    // switching to it is 403
    expect((await tech.agent.post('/api/me/active-shop').send({ shopId: owner.shopId })).status).toBe(403);
    // and the user can no longer read the shop row through the membership RLS policy
    const appDb = new PrismaClient({ datasourceUrl: process.env.APP_DATABASE_URL_TEST });
    try {
      const shops = await appDb.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.user_id', ${tech.userId}, true)`;
        return tx.shop.findMany();
      });
      expect(shops).toEqual([]);
    } finally {
      await appDb.$disconnect();
    }
  });

  it('a deactivated user with another shop falls back to it, with the banner once', async () => {
    const shopA = await ownerWithShop(app, { shopName: 'Shop Alpha' });
    const shopB = await ownerWithShop(app, { shopName: 'Shop Beta' });
    const person = await addMember(app, adminDb, shopB.shopId, 'TECHNICIAN', 'Two Shops');
    await adminDb.membership.create({ data: { shopId: shopA.shopId, userId: person.userId, role: 'MANAGER' } });
    await person.agent.post('/api/me/active-shop').send({ shopId: shopA.shopId }).expect(200);
    expect((await person.agent.get('/api/staff')).status).toBe(200);

    const membershipA = await adminDb.membership.findFirstOrThrow({ where: { shopId: shopA.shopId, userId: person.userId } });
    await shopA.agent.post(`/api/staff/${membershipA.id}/deactivate`).expect(200);

    expect((await person.agent.get('/api/staff')).status).toBe(403); // rejected, not silently run against shop B
    const me = MeResponse.parse((await person.agent.get('/api/me').expect(200)).body);
    expect(me.activeShop?.id).toBe(shopB.shopId);
    expect(me.role).toBe('TECHNICIAN');
    expect(me.accessRemoved).toEqual({ shopId: shopA.shopId, shopName: 'Shop Alpha' });
    expect(me.memberships.map((m) => m.shopId)).toEqual([shopB.shopId]);
    const me2 = MeResponse.parse((await person.agent.get('/api/me').expect(200)).body);
    expect(me2.accessRemoved).toBeNull(); // banner once
    expect((await person.agent.get('/api/timeclock/me')).status).toBe(200);
  });

  it('not self, manager limits, last owner, no-ops, reactivation with same role and seat check', async () => {
    const owner = await ownerWithShop(app);
    const manager = await addMember(app, adminDb, owner.shopId, 'MANAGER');
    const tech = await addMember(app, adminDb, owner.shopId, 'TECHNICIAN');
    const ownerMembership = (await adminDb.membership.findFirstOrThrow({ where: { shopId: owner.shopId, userId: owner.userId } })).id;

    const self = await manager.agent.post(`/api/staff/${manager.membershipId}/deactivate`);
    expect(self.status).toBe(403);
    expect(self.body).toMatchObject({ code: 'CANNOT_CHANGE_SELF', message: "You can't deactivate yourself." });
    expect((await manager.agent.post(`/api/staff/${ownerMembership}/deactivate`)).status).toBe(403);

    await manager.agent.post(`/api/staff/${tech.membershipId}/deactivate`).expect(200);
    await manager.agent.post(`/api/staff/${tech.membershipId}/deactivate`).expect(200); // no-op
    expect(await auditOf(adminDb, owner.shopId, 'member.deactivated')).toHaveLength(1);
    const roleOfDeactivated = await owner.agent.patch(`/api/staff/${tech.membershipId}/role`).send({ role: 'FRONT_DESK' });
    expect(roleOfDeactivated.body.code).toBe('MEMBER_DEACTIVATED');

    // fill seats: owner + manager + 3 invites = 5
    for (let i = 0; i < 3; i++) await owner.agent.post('/api/staff/invites').send({ email: uniqueEmail(), role: 'TECHNICIAN' }).expect(201);
    const full = await manager.agent.post(`/api/staff/${tech.membershipId}/reactivate`);
    expect(full.status).toBe(403);
    expect(full.body.code).toBe('SEAT_LIMIT_REACHED');

    const inv = (await list(owner)).items.find((i) => i.kind === 'INVITE')!;
    await owner.agent.post(`/api/staff/invites/${inv.id}/revoke`).expect(204);
    const back = StaffListItem.parse((await manager.agent.post(`/api/staff/${tech.membershipId}/reactivate`).expect(200)).body);
    expect(back).toMatchObject({ status: 'ACTIVE', role: 'TECHNICIAN', deactivatedAt: null });
    await manager.agent.post(`/api/staff/${tech.membershipId}/reactivate`).expect(200); // no-op
    expect(await auditOf(adminDb, owner.shopId, 'member.reactivated')).toHaveLength(1);
    expect((await tech.agent.get('/api/timeclock/me')).status).toBe(200);

  });

  it('LAST_OWNER: an owner cannot deactivate or demote the only other active owner when they are not counted', async () => {
    const owner = await ownerWithShop(app);
    const co = await addMember(app, adminDb, owner.shopId, 'OWNER');
    const ownerMembership = (await adminDb.membership.findFirstOrThrow({ where: { shopId: owner.shopId, userId: owner.userId } })).id;
    // The concurrent case: the actor was demoted by someone else between the guard and the write. The owner count
    // is re-checked under the shop row lock inside the write transaction, so the target stays.
    const { StaffService } = await import('../src/staff/staff.service');
    const service = app.get(StaffService);
    await adminDb.membership.update({ where: { id: ownerMembership }, data: { role: 'MANAGER' } });
    const actor = { userId: owner.userId, name: owner.name, email: owner.email, shopId: owner.shopId, role: 'OWNER' as const };
    await expect(service.deactivate(actor, co.membershipId)).rejects.toMatchObject({ response: { code: 'LAST_OWNER', statusCode: 409 } });
    await expect(service.changeRole(actor, co.membershipId, 'MANAGER')).rejects.toMatchObject({ response: { code: 'LAST_OWNER' } });
  });
});

describe('Risk #1 for the other membership checks', () => {
  it('a user whose only shop membership is deactivated can still create their own shop', async () => {
    const owner = await ownerWithShop(app);
    const tech = await addMember(app, adminDb, owner.shopId, 'TECHNICIAN');
    await owner.agent.post(`/api/staff/${tech.membershipId}/deactivate`).expect(200);
    const res = await tech.agent.post('/api/shops').send({ name: 'My Own Shop', country: 'GB' });
    expect(res.status).toBe(201);
    const me = MeResponse.parse((await tech.agent.get('/api/me').expect(200)).body);
    expect(me.activeShop?.id).toBe(Shop.parse(res.body).id);
    expect(me.accessRemoved).toBeNull();
    const status = TimeclockStatus.parse((await tech.agent.get('/api/timeclock/me').expect(200)).body);
    expect(status.openEntry).toBeNull();
  });
});
