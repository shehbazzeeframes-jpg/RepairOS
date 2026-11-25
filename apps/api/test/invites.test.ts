/** Story §3 (accepting invites), D7, D10, §8 email + dev outbox, D4 password reset, §7 shop cap. */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AcceptInviteResponse, InviteLinkResponse, InvitePreview, MeResponse, StaffListItem } from '@repairos/contracts';
import { PrismaClient } from '@repairos/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ageInviteSends, auditOf, emailsTo, inviteTokenFor, lastEmailTo, ownerWithShop, type OwnerWithShop } from './fixtures';
import { agentFor, APP_URL, createTestApp, signUp, uniqueEmail } from './helpers';

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

async function invite(owner: OwnerWithShop, role = 'FRONT_DESK', email = uniqueEmail('invitee')) {
  const row = StaffListItem.parse((await owner.agent.post('/api/staff/invites').send({ email, role }).expect(201)).body);
  return { row, email, token: await inviteTokenFor(email) };
}

describe('invite email (§8)', () => {
  it('is sent with subject, reply-to inviter, role line, button, link and expiry in shop time', async () => {
    const owner = await ownerWithShop(app, { name: 'Ava Khan', country: 'PK', shopName: 'Lahore Fix' });
    const { email, token } = await invite(owner, 'TECHNICIAN');
    const mail = (await lastEmailTo(email))!;
    expect(mail.subject).toBe('Ava Khan invited you to join Lahore Fix on RepairOS');
    expect(mail.text).toContain(`Ava Khan (${owner.email}) has invited you to join Lahore Fix as Technician.`);
    expect(mail.text).toContain(`${APP_URL}/invite/${token}`);
    expect(mail.html).toContain(`href="${APP_URL}/invite/${token}"`);
    expect(mail.html).toContain('Accept invite');
    expect(mail.text).toMatch(/This invite expires on .*(GMT\+5|PKT)/);
  });

  it('dev outbox API lists newest first (≤ 50) and returns one item; 404 for unknown ids', async () => {
    const owner = await ownerWithShop(app);
    const { email } = await invite(owner);
    const res = await request(app.getHttpServer()).get('/api/dev/outbox').expect(200);
    const items = res.body.items as { id: string; to: string; createdAt: string }[];
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThanOrEqual(50);
    expect(items[0]!.to).toBe(email);
    expect(Object.keys(items[0]!).sort()).toEqual(['createdAt', 'html', 'id', 'subject', 'text', 'to']);
    const sorted = [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    expect(items.map((i) => i.id)).toEqual(sorted.map((i) => i.id));
    const one = await request(app.getHttpServer()).get(`/api/dev/outbox/${items[0]!.id}`).expect(200);
    expect(one.body).toMatchObject({ id: items[0]!.id, to: email });
    expect((await request(app.getHttpServer()).get('/api/dev/outbox/nope')).status).toBe(404);
    expect((await request(app.getHttpServer()).get('/api/dev/outbox/..%2F..%2Fetc')).status).toBe(404);
  });

  it('dev outbox is 404 in production', async () => {
    const { DevOutboxController } = await import('../src/email/dev-outbox.controller');
    const { testConfig } = await import('./helpers');
    const prod = new DevOutboxController({ ...testConfig(), nodeEnv: 'production' });
    await expect(prod.list()).rejects.toMatchObject({ response: { statusCode: 404 } });
  });

  it('a failed send marks the invite FAILED (shown as "Email failed. Resend")', async () => {
    const failing = await createTestApp();
    const { EMAIL_PROVIDER } = await import('../src/email/email.service');
    const provider = failing.get<{ send: () => Promise<unknown> }>(EMAIL_PROVIDER);
    provider.send = async () => {
      throw new Error('provider down');
    };
    try {
      const owner = await ownerWithShop(failing);
      const res = await owner.agent.post('/api/staff/invites').send({ email: uniqueEmail(), role: 'TECHNICIAN' }).expect(201);
      expect(StaffListItem.parse(res.body).inviteEmailStatus).toBe('FAILED');
    } finally {
      await failing.close();
    }
  });
});

describe('invite preview (GET /api/invites/:token)', () => {
  it('VALID, EXPIRED, REVOKED, ACCEPTED(by me only), invalid and malformed', async () => {
    const owner = await ownerWithShop(app, { name: 'Ivy Inviter', shopName: 'Preview Shop' });
    const { row, email, token } = await invite(owner, 'TECHNICIAN');
    const anon = request(app.getHttpServer());

    const valid = InvitePreview.parse((await anon.get(`/api/invites/${token}`).expect(200)).body);
    expect(valid).toEqual({
      state: 'VALID',
      shopName: 'Preview Shop',
      inviterName: 'Ivy Inviter',
      role: 'TECHNICIAN',
      email,
      expiresAt: row.inviteExpiresAt,
    });

    await adminDb.invitation.update({ where: { id: row.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(InvitePreview.parse((await anon.get(`/api/invites/${token}`).expect(200)).body).state).toBe('EXPIRED');

    await owner.agent.post(`/api/staff/invites/${row.id}/revoke`).expect(204);
    expect((await anon.get(`/api/invites/${token}`).expect(200)).body).toEqual({ state: 'REVOKED' });

    for (const bad of ['x'.repeat(43), 'short', `${token}x`]) {
      const res = await anon.get(`/api/invites/${bad}`);
      expect(res.status, bad).toBe(404);
      expect(res.body).toMatchObject({ code: 'INVITE_INVALID', message: "This invite link isn't valid." });
    }

    const second = await invite(owner, 'TECHNICIAN');
    const joiner = agentFor(app);
    await signUp(joiner, 'Joiner', second.email);
    await joiner.post(`/api/invites/${second.token}/accept`).expect(200);
    expect(InvitePreview.parse((await joiner.get(`/api/invites/${second.token}`).expect(200)).body)).toEqual({
      state: 'ACCEPTED',
      shopId: owner.shopId,
      shopName: 'Preview Shop',
    });
    expect((await anon.get(`/api/invites/${second.token}`)).status).toBe(404); // signed out
    expect((await owner.agent.get(`/api/invites/${second.token}`)).status).toBe(404); // someone else
  });

  it('is rate limited per IP', async () => {
    const limited = await createTestApp({ invitePreviewRateLimit: 2 });
    try {
      const statuses = [];
      for (let i = 0; i < 3; i++) statuses.push((await request(limited.getHttpServer()).get(`/api/invites/${'a'.repeat(43)}`)).status);
      expect(statuses).toEqual([404, 404, 429]);
    } finally {
      await limited.close();
    }
  });
});

describe('accept (POST /api/invites/:token/accept)', () => {
  it('new account: membership, emailVerified (D7), active shop, audit; idempotent repeat', async () => {
    const owner = await ownerWithShop(app, { shopName: 'Join Me' });
    const { row, email, token } = await invite(owner, 'FRONT_DESK');
    const joiner = agentFor(app);
    const { userId } = await signUp(joiner, 'New Hire', email.toUpperCase());
    expect((await adminDb.user.findUniqueOrThrow({ where: { id: userId } })).emailVerified).toBe(false);

    const res = AcceptInviteResponse.parse((await joiner.post(`/api/invites/${token}/accept`).expect(200)).body);
    expect(res).toEqual({ shopId: owner.shopId, shopName: 'Join Me', role: 'FRONT_DESK', alreadyMember: false });

    expect((await adminDb.user.findUniqueOrThrow({ where: { id: userId } })).emailVerified).toBe(true);
    const inv = await adminDb.invitation.findUniqueOrThrow({ where: { id: row.id } });
    expect(inv).toMatchObject({ status: 'ACCEPTED', acceptedByUserId: userId });
    const me = MeResponse.parse((await joiner.get('/api/me').expect(200)).body);
    expect(me).toMatchObject({ activeShop: { id: owner.shopId }, role: 'FRONT_DESK' });
    const [audit] = await auditOf(adminDb, owner.shopId, 'invite.accepted');
    expect(audit).toMatchObject({
      actorUserId: userId,
      entityId: row.id,
      before: { status: 'PENDING' },
      after: { status: 'ACCEPTED', emailVerified: true, role: 'FRONT_DESK' },
    });
    expect(JSON.stringify(audit)).not.toContain(token);

    // repeat (double click / second tab) → 200 alreadyMember, nothing new
    const again = AcceptInviteResponse.parse((await joiner.post(`/api/invites/${token}/accept`).expect(200)).body);
    expect(again.alreadyMember).toBe(true);
    expect(await auditOf(adminDb, owner.shopId, 'invite.accepted')).toHaveLength(1);
    // the invite no longer shows and the person now holds a seat as a member
    const staff = (await owner.agent.get('/api/staff').expect(200)).body as { items: StaffListItem[]; seats: { used: number } };
    expect(staff.items.filter((i) => i.kind === 'INVITE')).toEqual([]);
    expect(staff.seats.used).toBe(2);
  });

  it('existing account with another shop gets a second membership; concurrent accepts are safe', async () => {
    const owner = await ownerWithShop(app, { shopName: 'Second Shop' });
    const other = await ownerWithShop(app, { shopName: 'Own Shop' });
    const { token } = await invite(owner, 'MANAGER', other.email);
    const results = await Promise.all([1, 2, 3].map(() => other.agent.post(`/api/invites/${token}/accept`)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(results.filter((r) => r.body.alreadyMember === false)).toHaveLength(1);
    expect(await adminDb.membership.count({ where: { shopId: owner.shopId, userId: other.userId } })).toBe(1);
    const me = MeResponse.parse((await other.agent.get('/api/me').expect(200)).body);
    expect(me.memberships.map((m) => m.shopName).sort()).toEqual(['Own Shop', 'Second Shop']);
    expect(me.activeShop?.id).toBe(owner.shopId);
  });

  it('INVITE_EMAIL_MISMATCH leaves the invite unchanged (case-insensitive match passes)', async () => {
    const owner = await ownerWithShop(app);
    const { row, email, token } = await invite(owner);
    const wrong = agentFor(app);
    const { email: wrongEmail } = await signUp(wrong);
    const res = await wrong.post(`/api/invites/${token}/accept`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: 'INVITE_EMAIL_MISMATCH',
      message: `This invite is for ${email}, but you're signed in as ${wrongEmail}.`,
    });
    expect((await adminDb.invitation.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('PENDING');
  });

  it('expired → 410 INVITE_EXPIRED, revoked → 410 INVITE_REVOKED, accepted by someone else / unknown → 404', async () => {
    const owner = await ownerWithShop(app);
    const a = await invite(owner);
    const userA = agentFor(app);
    await signUp(userA, 'A', a.email);
    await adminDb.invitation.update({ where: { id: a.row.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await userA.post(`/api/invites/${a.token}/accept`);
    expect(expired.status).toBe(410);
    expect(expired.body.code).toBe('INVITE_EXPIRED');

    const b = await invite(owner);
    const userB = agentFor(app);
    await signUp(userB, 'B', b.email);
    await owner.agent.post(`/api/staff/invites/${b.row.id}/revoke`).expect(204);
    const revoked = await userB.post(`/api/invites/${b.token}/accept`);
    expect(revoked.status).toBe(410);
    expect(revoked.body.code).toBe('INVITE_REVOKED');

    const c = await invite(owner);
    const userC = agentFor(app);
    await signUp(userC, 'C', c.email);
    await userC.post(`/api/invites/${c.token}/accept`).expect(200);
    const someoneElse = await userA.post(`/api/invites/${c.token}/accept`);
    expect(someoneElse.status).toBe(404);
    expect(someoneElse.body.code).toBe('INVITE_INVALID');
    expect((await userA.post(`/api/invites/${'z'.repeat(43)}/accept`)).status).toBe(404);
    expect((await userA.post('/api/invites/not-a-token/accept')).status).toBe(404);
    expect((await agentFor(app).post(`/api/invites/${c.token}/accept`)).status).toBe(401);
  });

  it('resend kills the old link; the new emailed link works', async () => {
    const owner = await ownerWithShop(app);
    const { row, email, token: oldToken } = await invite(owner);
    await owner.agent.post(`/api/staff/invites/${row.id}/resend`).expect(200);
    const newToken = await inviteTokenFor(email);
    expect(newToken).not.toBe(oldToken);
    expect(await emailsTo(email)).toHaveLength(2);
    const joiner = agentFor(app);
    await signUp(joiner, 'J', email);
    expect((await joiner.post(`/api/invites/${oldToken}/accept`)).status).toBe(404);
    await joiner.post(`/api/invites/${newToken}/accept`).expect(200);
  });

  it('D10 copy link: rotates the token, sends no email, audited without the URL; D7: emailVerified stays false', async () => {
    const owner = await ownerWithShop(app);
    const { row, email, token: emailed } = await invite(owner);
    const linkRes = InviteLinkResponse.parse((await owner.agent.post(`/api/staff/invites/${row.id}/link`).expect(200)).body);
    const copied = linkRes.url.match(/\/invite\/([\w-]{43})$/)![1]!;
    expect(linkRes.url).toBe(`${APP_URL}/invite/${copied}`);
    expect(copied).not.toBe(emailed);
    expect(await emailsTo(email)).toHaveLength(1);
    const stored = await adminDb.invitation.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.linkCopiedAt).not.toBeNull();
    const [audit] = await auditOf(adminDb, owner.shopId, 'invite.link_copied');
    expect(audit).toMatchObject({ entityId: row.id, after: { email, role: 'FRONT_DESK' } });
    expect(JSON.stringify(audit)).not.toContain(copied);

    // staff list shows the copy time; second copy within a minute is rate limited, after that it works
    const list = (await owner.agent.get('/api/staff').expect(200)).body as { items: StaffListItem[] };
    expect(list.items.find((i) => i.id === row.id)?.inviteLinkCopiedAt).not.toBeNull();
    expect((await owner.agent.post(`/api/staff/invites/${row.id}/link`)).status).toBe(429);
    await ageInviteSends(adminDb, row.id);
    const latest = InviteLinkResponse.parse((await owner.agent.post(`/api/staff/invites/${row.id}/link`).expect(200)).body);
    const latestToken = latest.url.split('/').pop()!;

    const joiner = agentFor(app);
    const { userId } = await signUp(joiner, 'WhatsApp Joiner', email);
    expect((await joiner.post(`/api/invites/${copied}/accept`)).status).toBe(404);
    await joiner.post(`/api/invites/${latestToken}/accept`).expect(200);
    expect((await adminDb.user.findUniqueOrThrow({ where: { id: userId } })).emailVerified).toBe(false);
    expect((await auditOf(adminDb, owner.shopId, 'invite.accepted'))[0]!.after).toMatchObject({ emailVerified: false });
  });

  it('resend/copy are capped at 5 per day per invite', async () => {
    const owner = await ownerWithShop(app);
    const { row } = await invite(owner);
    for (let i = 0; i < 5; i++) {
      await owner.agent.post(`/api/staff/invites/${row.id}/${i % 2 ? 'link' : 'resend'}`).expect(200);
      await ageInviteSends(adminDb, row.id);
    }
    const res = await owner.agent.post(`/api/staff/invites/${row.id}/resend`);
    expect(res.status).toBe(429);
    expect(res.body.message).toMatch(/too many times today/);
  });

  it('a deactivated member who accepts a new invite is reactivated with the invite role', async () => {
    const owner = await ownerWithShop(app);
    const first = await invite(owner, 'TECHNICIAN');
    const person = agentFor(app);
    await signUp(person, 'Back Again', first.email);
    await person.post(`/api/invites/${first.token}/accept`).expect(200);
    const membership = await adminDb.membership.findFirstOrThrow({ where: { shopId: owner.shopId, user: { email: first.email } } });
    await owner.agent.post(`/api/staff/${membership.id}/deactivate`).expect(200);
    // MEMBER_DEACTIVATED blocks a normal invite; simulate an invite that predates the deactivation
    const { newInviteToken } = await import('../src/staff/staff.mappers');
    const { token, tokenHash } = newInviteToken();
    await adminDb.invitation.create({
      data: { shopId: owner.shopId, email: first.email, role: 'FRONT_DESK', tokenHash, expiresAt: new Date(Date.now() + 3600_000) },
    });
    const res = AcceptInviteResponse.parse((await person.post(`/api/invites/${token}/accept`).expect(200)).body);
    expect(res).toMatchObject({ role: 'FRONT_DESK', alreadyMember: false });
    expect(await adminDb.membership.findUniqueOrThrow({ where: { id: membership.id } })).toMatchObject({ status: 'ACTIVE', role: 'FRONT_DESK' });
  });

  it('an invite token for shop A never grants shop B', async () => {
    const shopA = await ownerWithShop(app, { shopName: 'Shop A' });
    const shopB = await ownerWithShop(app, { shopName: 'Shop B' });
    const { email, token } = await invite(shopA);
    const joiner = agentFor(app);
    const { userId } = await signUp(joiner, 'Cross', email);
    const res = AcceptInviteResponse.parse((await joiner.post(`/api/invites/${token}/accept`).expect(200)).body);
    expect(res.shopId).toBe(shopA.shopId);
    expect(await adminDb.membership.count({ where: { userId, shopId: shopB.shopId } })).toBe(0);
    expect((await joiner.post('/api/me/active-shop').send({ shopId: shopB.shopId })).status).toBe(403);
  });
});

describe('forgot password (D4)', () => {
  it('emails a reset link that lands on /reset-password?token=… and resets the password', async () => {
    const agent = agentFor(app);
    const { email } = await signUp(agent, 'Forgetful');
    const res = await agentFor(app).post('/api/auth/request-password-reset').send({ email: email.toUpperCase() });
    expect(res.status).toBe(200);
    const mail = (await lastEmailTo(email))!;
    expect(mail.subject).toBe('Reset your RepairOS password');
    const link = mail.text.match(/http:\/\/localhost:3000(\/api\/auth\/reset-password\/[^\s]+)/)![1]!;
    expect(link).toContain(`callbackURL=${encodeURIComponent(`${APP_URL}/reset-password`)}`);

    const redirect = await request(app.getHttpServer()).get(link).set('Origin', APP_URL);
    expect(redirect.status).toBe(302);
    const location = new URL(redirect.headers.location as string);
    expect(`${location.origin}${location.pathname}`).toBe(`${APP_URL}/reset-password`);
    const token = location.searchParams.get('token')!;
    expect(token).toBeTruthy();

    await agentFor(app).post('/api/auth/reset-password').send({ token, newPassword: 'NewPassword456!' }).expect(200);
    await agentFor(app).post('/api/auth/sign-in/email').send({ email, password: 'NewPassword456!' }).expect(200);
    expect((await agentFor(app).post('/api/auth/sign-in/email').send({ email, password: 'Password123!' })).status).toBe(401);
  });

  it('does not reveal whether an account exists, and is rate limited per IP + email', async () => {
    const limited = await createTestApp({ authRateLimitMax: 2 });
    try {
      const post = () => request(limited.getHttpServer()).post('/api/auth/request-password-reset').set('Origin', APP_URL).send({ email: 'ghost@test.repairos.dev' });
      expect((await post()).status).toBe(200);
      expect((await post()).status).toBe(200);
      expect((await post()).status).toBe(429);
      expect(await lastEmailTo('ghost@test.repairos.dev')).toBeUndefined();
    } finally {
      await limited.close();
    }
  });
});

describe('shop creation cap (§7)', () => {
  it('the 3rd owned shop succeeds and the 4th is 403 SHOP_LIMIT_REACHED; non-owner and deactivated owner shops do not count', async () => {
    const owner = await ownerWithShop(app);
    await owner.agent.post('/api/shops').send({ name: 'Two', country: 'US' }).expect(201);
    await owner.agent.post('/api/shops').send({ name: 'Three', country: 'US' }).expect(201);
    const fourth = await owner.agent.post('/api/shops').send({ name: 'Four', country: 'US' });
    expect(fourth.status).toBe(403);
    expect(fourth.body).toEqual({
      statusCode: 403,
      code: 'SHOP_LIMIT_REACHED',
      message: 'You can own up to 3 shops for now. Contact support if you need more.',
    });

    // demote one owned shop to MANAGER: now owns 2 → can create again
    const m = await adminDb.membership.findFirstOrThrow({ where: { userId: owner.userId, shopId: owner.shopId } });
    await adminDb.membership.update({ where: { id: m.id }, data: { role: 'MANAGER' } });
    await owner.agent.post('/api/shops').send({ name: 'Four', country: 'US' }).expect(201);
    expect((await owner.agent.post('/api/shops').send({ name: 'Five', country: 'US' })).status).toBe(403);
    // a deactivated OWNER membership doesn't count
    const own = await adminDb.membership.findFirstOrThrow({ where: { userId: owner.userId, role: 'OWNER' } });
    await adminDb.membership.update({ where: { id: own.id }, data: { status: 'DEACTIVATED' } });
    await owner.agent.post('/api/shops').send({ name: 'Five', country: 'US' }).expect(201);
  });

  it('more than N shops per hour → 429 RATE_LIMITED', async () => {
    const limited = await createTestApp({ shopCreatePerHour: 2, shopOwnedLimit: 10 });
    try {
      const agent = agentFor(limited);
      await signUp(agent);
      await agent.post('/api/shops').send({ name: 'One', country: 'US' }).expect(201);
      await agent.post('/api/shops').send({ name: 'Two', country: 'US' }).expect(201);
      const third = await agent.post('/api/shops').send({ name: 'Three', country: 'US' });
      expect(third.status).toBe(429);
      expect(third.body).toMatchObject({ code: 'RATE_LIMITED', message: 'Too many shops created. Try again later.' });
    } finally {
      await limited.close();
    }
  });

  it('new shops get D9 business hours and goods/services tax defaults', async () => {
    const owner = await ownerWithShop(app, { country: 'PK' });
    const settings = (await owner.agent.get('/api/shop').expect(200)).body;
    expect(settings.hours[0]).toEqual({ weekday: 0, isOpen: false, opensAt: null, closesAt: null });
    expect(settings.hours[1]).toEqual({ weekday: 1, isOpen: true, opensAt: '10:00', closesAt: '19:00' });
    const rates = (await owner.agent.get('/api/shop/tax-rates').expect(200)).body.items;
    expect(rates.map((r: { name: string; isDefaultGoods: boolean; isDefaultServices: boolean }) => [r.name, r.isDefaultGoods, r.isDefaultServices])).toEqual([
      ['GST', true, false],
      ['Sales tax on services', false, true],
    ]);
  });
});
