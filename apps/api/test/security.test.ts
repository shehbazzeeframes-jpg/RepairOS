/** Sprint 1 review fixes: tokens never in logs (BUG-01/H1), Better Auth origin + redirect checks (L3), reset cap (L4). */
import { Writable } from 'node:stream';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { StaffListItem } from '@repairos/contracts';
import { PrismaClient } from '@repairos/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isTokenUrl, redactSecrets, serializeReq, serializeRes } from '../src/common/log-redact';
import { emailsTo, inviteTokenFor, lastEmailTo, ownerWithShop } from './fixtures';
import { agentFor, APP_URL, createTestApp, signUp, uniqueEmail } from './helpers';

let app: NestExpressApplication;
let adminDb: PrismaClient;
const logLines: string[] = [];

beforeAll(async () => {
  const sink = new Writable({
    write(chunk: Buffer, _enc, done) {
      logLines.push(chunk.toString('utf8'));
      done();
    },
  });
  app = await createTestApp({ logLevel: 'debug' }, { logDestination: sink });
  adminDb = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL_TEST });
});
afterAll(async () => {
  await adminDb?.$disconnect();
  await app?.close();
});

describe('BUG-01: invite and reset tokens never reach the logs', () => {
  it('preview, accept, reset callback, reset and page requests with a token Referer log no token', async () => {
    logLines.length = 0;
    const owner = await ownerWithShop(app);
    const email = uniqueEmail('invitee');
    StaffListItem.parse((await owner.agent.post('/api/staff/invites').send({ email, role: 'FRONT_DESK' }).expect(201)).body);
    const inviteToken = await inviteTokenFor(email);
    const invitePage = `${APP_URL}/invite/${inviteToken}`;

    // The invite page: preview (signed out), /me, sign-up, accept; every call carries the page as Referer.
    await request(app.getHttpServer()).get(`/api/invites/${inviteToken}`).set('Referer', invitePage).expect(200);
    await request(app.getHttpServer()).get(`/api/invites/${inviteToken}?token=${inviteToken}`).set('Referer', invitePage).expect(200);
    const invitee = agentFor(app).set('Referer', invitePage);
    await signUp(invitee, 'Ines Invitee', email);
    await invitee.get('/api/me').expect(200);
    await invitee.post(`/api/invites/${inviteToken}/accept`).expect(200);
    await invitee.post(`/api/invites/${inviteToken}x/accept`).expect(404);

    // Forgot password: email → Better Auth callback (302 with ?token=) → the page's API calls → reset.
    const { email: forgetful } = await signUp(agentFor(app), 'Forgetful');
    await agentFor(app).post('/api/auth/request-password-reset').send({ email: forgetful }).expect(200);
    const link = (await lastEmailTo(forgetful))!.text.match(/http:\/\/localhost:3000(\/api\/auth\/reset-password\/[^\s]+)/)![1]!;
    const pathToken = link.split('/').pop()!.split('?')[0]!;
    const redirect = await request(app.getHttpServer()).get(link).expect(302);
    const resetToken = new URL(redirect.headers.location as string).searchParams.get('token')!;
    expect(resetToken).toBe(pathToken);
    const resetPage = `${APP_URL}/reset-password?token=${resetToken}`;
    await request(app.getHttpServer()).get('/api/me').set('Referer', resetPage).expect(401);
    await agentFor(app)
      .post('/api/auth/reset-password')
      .set('Referer', resetPage)
      .send({ token: resetToken, newPassword: 'NewPassword456!' })
      .expect(200);
    // A replayed (now invalid) token goes down Better Auth's error path, which logs too.
    await request(app.getHttpServer()).get(link).expect(302);
    await agentFor(app).post('/api/auth/reset-password').send({ token: resetToken, newPassword: 'NewPassword789!' }).expect(400);

    const log = logLines.join('');
    expect(log).toContain('/api/invites/[REDACTED]'); // the requests were logged…
    expect(log).toContain('/api/auth/reset-password/[REDACTED]');
    expect(log).not.toContain(inviteToken); // …without the tokens
    expect(log).not.toContain(resetToken);
    expect(log).not.toMatch(/"referer"/i);
  });

  it('redaction helpers mask path tokens, ?token= and Location, and drop params/query/referer', () => {
    expect(redactSecrets('/api/invites/abc/accept')).toBe('/api/invites/[REDACTED]/accept');
    expect(redactSecrets('http://x/invite/abc?y=1')).toBe('http://x/invite/[REDACTED]?y=1');
    expect(redactSecrets('/api/auth/reset-password/abc?callbackURL=%2Fx')).toBe('/api/auth/reset-password/[REDACTED]?callbackURL=%2Fx');
    expect(redactSecrets('http://x/reset-password?token=abc&a=1')).toBe('http://x/reset-password?token=[REDACTED]&a=1');
    expect(redactSecrets('/api/auth/reset-password')).toBe('/api/auth/reset-password');
    expect(isTokenUrl('/api/invites/abc')).toBe(true);
    expect(isTokenUrl('/api/staff/invites')).toBe(false);
    const req = serializeReq({
      method: 'GET',
      url: '/api/invites/abc',
      query: { a: '1' },
      params: { token: 'abc' },
      headers: { referer: 'http://x/invite/abc', Referer: 'x', 'user-agent': 'ua' },
    });
    expect(req).toEqual({ method: 'GET', url: '/api/invites/[REDACTED]', headers: { 'user-agent': 'ua' } });
    expect(serializeReq({ url: '/api/x?token=abc', query: { token: 'abc' } })).toEqual({ url: '/api/x?token=[REDACTED]', query: { token: '[REDACTED]' } });
    expect(serializeRes({ statusCode: 302, headers: { location: 'http://x/reset-password?token=abc' } })).toEqual({
      statusCode: 302,
      headers: { location: 'http://x/reset-password?token=[REDACTED]' },
    });
  });
});

describe('L3: Better Auth origin and redirect checks are on in tests', () => {
  it('rejects an external redirectTo on request-password-reset (and sends nothing)', async () => {
    const { email } = await signUp(agentFor(app), 'Target');
    const before = (await emailsTo(email)).length;
    const res = await agentFor(app).post('/api/auth/request-password-reset').send({ email, redirectTo: 'https://evil.example/steal' });
    expect(res.status).toBe(403);
    expect((await emailsTo(email)).length).toBe(before);
    // Same-origin and relative redirects are accepted.
    await agentFor(app).post('/api/auth/request-password-reset').send({ email, redirectTo: `${APP_URL}/reset-password` }).expect(200);
    await agentFor(app).post('/api/auth/request-password-reset').send({ email, redirectTo: '/reset-password' }).expect(200);
  });

  it('rejects a cookie-carrying auth request from an untrusted Origin', async () => {
    const agent = agentFor(app);
    await signUp(agent);
    const res = await agent.post('/api/auth/sign-out').set('Origin', 'https://evil.example').send({});
    expect(res.status).toBe(403);
    await agent.get('/api/me').expect(200); // still signed in
    await agent.post('/api/auth/sign-out').set('Origin', APP_URL).send({}).expect(200);
  });
});

describe('L4: per-account password-reset cap across IPs', () => {
  it('sends at most N reset emails per hour for one account, from any IP; the response never changes', async () => {
    const capped = await createTestApp({ passwordResetPerEmailHour: 2, authRateLimitMax: 1000 });
    try {
      const { email } = await signUp(agentFor(capped), 'Spammed');
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await request(capped.getHttpServer())
          .post('/api/auth/request-password-reset')
          .set('Origin', APP_URL)
          .set('X-Forwarded-For', `203.0.113.${i + 1}`)
          .send({ email });
        statuses.push(res.status);
      }
      expect(statuses).toEqual([200, 200, 200, 200, 200]);
      expect((await emailsTo(email)).filter((m) => m.subject === 'Reset your RepairOS password')).toHaveLength(2);
      // Stored in the database (Better Auth's verifications), so a restart does not reset the count.
      const restarted = await createTestApp({ passwordResetPerEmailHour: 2, authRateLimitMax: 1000 });
      try {
        await request(restarted.getHttpServer()).post('/api/auth/request-password-reset').set('Origin', APP_URL).send({ email }).expect(200);
        expect((await emailsTo(email)).filter((m) => m.subject === 'Reset your RepairOS password')).toHaveLength(2);
      } finally {
        await restarted.close();
      }
      // Requests older than an hour no longer count.
      await adminDb.verification.updateMany({
        where: { identifier: { startsWith: 'reset-password:' } },
        data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
      });
      await request(capped.getHttpServer()).post('/api/auth/request-password-reset').set('Origin', APP_URL).send({ email }).expect(200);
      expect((await emailsTo(email)).filter((m) => m.subject === 'Reset your RepairOS password')).toHaveLength(3);
    } finally {
      await capped.close();
    }
  });
});
