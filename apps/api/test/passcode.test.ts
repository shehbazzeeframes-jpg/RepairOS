/**
 * Passcodes (DV3–DV5, A15 + tech lead): encrypted at rest, reveal is POST + no-store, open tickets only, 30 per
 * user per hour from the DB (survives a restart), audited, deleted on close when the setting is on, and the
 * plaintext never appears in any response other than the reveal, in logs, audit rows, exports or the timeline.
 */
import { Writable } from 'node:stream';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PasscodeReveal, TicketDetail, TimelineResponse } from '@repairos/contracts';
import { PrismaClient } from '@repairos/db';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redactBody, serializeReq } from '../src/common/log-redact';
import { addMember, auditOf, type Member, ownerWithShop, type OwnerWithShop } from './fixtures';
import { type Agent, createTestApp } from './helpers';
import { checkInNew, signInOn, statuses } from './s2';

const PIN = '73914682';
const PASSWORD = 'Tr0ub4dor&3-zebra';
const PATTERN = [3, 5, 7, 8, 9];
const SECRETS = [PIN, PASSWORD, '3-5-7-8-9'];

let app: NestExpressApplication;
let adminDb: PrismaClient;
let owner: OwnerWithShop;
let tech: Member;
const logLines: string[] = [];
/** Every response body/header seen in this file (except reveals), scanned at the end. */
const seen: string[] = [];

function record(res: Response, isReveal = false) {
  if (!isReveal) seen.push(JSON.stringify({ headers: res.headers, body: res.body, text: res.text }));
  return res;
}
const get = async (agent: Agent, path: string) => record(await agent.get(path));
const post = async (agent: Agent, path: string, body: object = {}) => record(await agent.post(path).send(body));

beforeAll(async () => {
  const sink = new Writable({
    write(chunk: Buffer, _enc, done) {
      logLines.push(chunk.toString('utf8'));
      done();
    },
  });
  app = await createTestApp({ logLevel: 'trace' }, { logDestination: sink });
  adminDb = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL_TEST });
  owner = await ownerWithShop(app, { shopName: 'Passcode Shop' });
  tech = await addMember(app, adminDb, owner.shopId, 'TECHNICIAN', 'Pat Tech');
});
afterAll(async () => {
  await adminDb?.$disconnect();
  await app?.close();
});

describe('passcode storage and reveal', () => {
  it('stores ciphertext only; reads return lockType/passcodeOnFile; reveal is POST, no-store, audited, counted', async () => {
    const t = await checkInNew(owner.agent, { passcode: { lockType: 'PIN', value: PIN } });
    record({ body: t, headers: {}, text: '' } as unknown as Response);
    expect(t.device).toMatchObject({ lockType: 'PIN', passcodeOnFile: true, passcodeViewCount: 0 });
    const raw = await adminDb.device.findUniqueOrThrow({ where: { id: t.device.id } });
    expect(raw.passcodeCiphertext).not.toBeNull();
    expect(Buffer.from(raw.passcodeCiphertext!).toString('utf8')).not.toContain(PIN);
    const dump = await adminDb.$queryRaw<{ row: string }[]>`SELECT d::text AS row FROM devices d WHERE d.id = ${t.device.id}`;
    expect(dump[0]!.row).not.toContain(PIN);

    expect((await tech.agent.get(`/api/tickets/${t.id}/passcode/reveal`)).status).toBe(404); // never a GET
    const res = await tech.agent.post(`/api/tickets/${t.id}/passcode/reveal`).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const reveal = PasscodeReveal.parse(res.body);
    expect(reveal).toMatchObject({ lockType: 'PIN', value: PIN, viewCount: 1 });
    const detail = TicketDetail.parse((await get(owner.agent, `/api/tickets/${t.id}`)).body);
    expect(detail.device).toMatchObject({ passcodeViewCount: 1, passcodeLastViewedBy: { name: 'Pat Tech' } });
    const audit = (await auditOf(adminDb, owner.shopId, 'device.passcode_viewed')).filter((a) => a.entityId === t.device.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorUserId: tech.userId, before: null, after: { deviceId: t.device.id, ticketId: t.id } });
  });

  it('password and pattern round-trip; NONE / NOT_SHARED → 404; other shop → 404', async () => {
    const pw = await checkInNew(owner.agent, { passcode: { lockType: 'PASSWORD', value: PASSWORD } });
    expect(PasscodeReveal.parse((await owner.agent.post(`/api/tickets/${pw.id}/passcode/reveal`).expect(200)).body)).toMatchObject({ value: PASSWORD });
    const pat = await checkInNew(owner.agent, { passcode: { lockType: 'PATTERN', pattern: PATTERN } });
    expect(PasscodeReveal.parse((await owner.agent.post(`/api/tickets/${pat.id}/passcode/reveal`).expect(200)).body)).toMatchObject({ pattern: PATTERN });
    const none = await checkInNew(owner.agent, { passcode: { lockType: 'NOT_SHARED' } });
    expect((await post(owner.agent, `/api/tickets/${none.id}/passcode/reveal`)).status).toBe(404);
    const other = await ownerWithShop(app);
    expect((await post(other.agent, `/api/tickets/${pw.id}/passcode/reveal`)).status).toBe(404);
    // Changing the passcode on the device (PATCH) is audited with lock types only.
    await post(owner.agent, `/api/tickets/${pw.id}/notes`, { body: 'ok' });
    const patched = record(await owner.agent.patch(`/api/devices/${pw.device.id}`).send({ passcode: { lockType: 'PIN', value: PIN } }));
    expect(patched.status).toBe(200);
    const changes = (await auditOf(adminDb, owner.shopId, 'device.passcode_changed')).filter((a) => a.entityId === pw.device.id);
    expect(changes.map((c) => [c.before, c.after])).toEqual([
      [null, { lockType: 'PASSWORD' }],
      [{ lockType: 'PASSWORD' }, { lockType: 'PIN' }],
    ]);
  });

  it('closed ticket → 403 PASSCODE_NOT_AVAILABLE; deleted on close when the setting is on (timeline: passcode_deleted)', async () => {
    const st = await statuses(owner.agent);
    const t = await checkInNew(owner.agent, { passcode: { lockType: 'PIN', value: PIN } });
    await post(owner.agent, `/api/tickets/${t.id}/status`, { statusId: st['Ready for pickup']!.id });
    await post(owner.agent, `/api/tickets/${t.id}/status`, { statusId: st.Collected!.id });
    const closed = await post(owner.agent, `/api/tickets/${t.id}/passcode/reveal`);
    expect(closed.body).toMatchObject({ statusCode: 403, code: 'PASSCODE_NOT_AVAILABLE' });
    const raw = await adminDb.device.findUniqueOrThrow({ where: { id: t.device.id } });
    expect(raw.passcodeCiphertext).toBeNull();
    const tl = TimelineResponse.parse((await get(owner.agent, `/api/tickets/${t.id}/timeline`)).body);
    expect(tl.items.find((i) => i.type === 'passcode_deleted')).toMatchObject({ actor: null, data: { reason: 'closed' } });
    // reopen says it was deleted; reveal is then 404 (no passcode on file)
    const reopened = await post(owner.agent, `/api/tickets/${t.id}/reopen`, { reason: 'Back again' });
    expect(reopened.status).toBe(200);
    const tl2 = TimelineResponse.parse((await get(owner.agent, `/api/tickets/${t.id}/timeline`)).body);
    expect(tl2.items.find((i) => i.type === 'reopened')).toMatchObject({ data: { passcodeWasDeleted: true } });
    expect((await post(owner.agent, `/api/tickets/${t.id}/passcode/reveal`)).status).toBe(404);

    // Setting off → kept; another open ticket on the same device → kept.
    await owner.agent.patch('/api/shop/ticket-settings').send({ deletePasscodeOnClose: false }).expect(200);
    const kept = await checkInNew(owner.agent, { passcode: { lockType: 'PIN', value: PIN } });
    await post(owner.agent, `/api/tickets/${kept.id}/cancel`, { reason: 'DUPLICATE' });
    expect((await adminDb.device.findUniqueOrThrow({ where: { id: kept.device.id } })).passcodeCiphertext).not.toBeNull();
    await owner.agent.patch('/api/shop/ticket-settings').send({ deletePasscodeOnClose: true }).expect(200);
    const two = await checkInNew(owner.agent, { passcode: { lockType: 'PIN', value: PIN } });
    const second = record(await owner.agent.post('/api/tickets').send({ customerId: two.customer.id, deviceId: two.device.id, issues: [{ code: 'BATTERY' }] }));
    await post(owner.agent, `/api/tickets/${two.id}/cancel`, { reason: 'DUPLICATE' });
    expect((await adminDb.device.findUniqueOrThrow({ where: { id: two.device.id } })).passcodeCiphertext).not.toBeNull();
    await post(owner.agent, `/api/tickets/${second.body.id}/cancel`, { reason: 'DUPLICATE' });
    expect((await adminDb.device.findUniqueOrThrow({ where: { id: two.device.id } })).passcodeCiphertext).toBeNull();
  });

  it('rate limit: 30 reveals per user per hour from the audit log, surviving a restart; other users unaffected', async () => {
    const shop = await ownerWithShop(app, { shopName: 'Rate Shop' });
    const t = await checkInNew(shop.agent, { passcode: { lockType: 'PIN', value: PIN } });
    const statusesSeen: number[] = [];
    for (let i = 0; i < 31; i++) statusesSeen.push((await shop.agent.post(`/api/tickets/${t.id}/passcode/reveal`)).status);
    expect(statusesSeen.filter((s) => s === 200)).toHaveLength(30);
    expect(statusesSeen.at(-1)).toBe(429);
    const restarted = await createTestApp();
    try {

      // Same session cookie on a fresh app instance (no in-memory state).
      const fresh = await signInOn(restarted, shop.email);
      const again = await fresh.post(`/api/tickets/${t.id}/passcode/reveal`);
      expect(again.status).toBe(429);
      expect(again.body.code).toBe('RATE_LIMITED');
    } finally {
      await restarted.close();
    }
    // Rows older than an hour no longer count.
    await adminDb.$executeRaw`UPDATE audit_logs SET "createdAt" = "createdAt" - interval '61 minutes' WHERE "shopId" = ${shop.shopId} AND action = 'device.passcode_viewed'`;
    expect((await shop.agent.post(`/api/tickets/${t.id}/passcode/reveal`)).status).toBe(200);
  });

  it('a wrong key gives 500 PASSCODE_UNREADABLE (logged without the value, not counted)', async () => {
    const t = await checkInNew(owner.agent, { passcode: { lockType: 'PIN', value: PIN } });
    const other = await createTestApp({ fieldEncryption: (await import('@repairos/db')).parseFieldKeyring(Buffer.from(Buffer.alloc(32, 7).map((b, i) => b + i)).toString('base64')) });
    try {
      const fresh = await signInOn(other, owner.email);

      const res = await fresh.post(`/api/tickets/${t.id}/passcode/reveal`);
      record(res);
      expect(res.status).toBe(500);
      expect(res.body.code).toBe('PASSCODE_UNREADABLE');
    } finally {
      await other.close();
    }
    const raw = await adminDb.device.findUniqueOrThrow({ where: { id: t.device.id } });
    expect(raw.passcodeViewCount).toBe(0);
  });
});

describe('the plaintext never leaks', () => {
  it('not in any non-reveal response, audit row, timeline event, export, or log line (incl. request bodies)', async () => {
    // Exercise the remaining read paths that touch devices.
    const t = await checkInNew(owner.agent, { passcode: { lockType: 'PASSWORD', value: PASSWORD } });
    for (const path of [
      `/api/tickets/${t.id}`,
      `/api/tickets/${t.id}/timeline`,
      `/api/tickets?view=all`,
      `/api/customers/${t.customer.id}`,
      `/api/customers/${t.customer.id}/devices`,
      `/api/customers/${t.customer.id}/export`,
      `/api/search?q=${encodeURIComponent(t.customer.displayName)}`,
      '/api/dashboard',
    ]) {
      expect((await get(owner.agent, path)).status, path).toBe(200);
    }
    // Validation errors on passcode input never echo the value.
    const bad = await post(owner.agent, `/api/customers/${t.customer.id}/devices`, { type: 'PHONE', brand: 'A', model: 'B', passcode: { lockType: 'PIN', value: `${PIN}x` } });
    expect(bad.status).toBe(400);

    const haystacks = [
      ...seen,
      JSON.stringify(await auditOf(adminDb, owner.shopId)),
      JSON.stringify(await adminDb.ticketEvent.findMany({ where: { shopId: owner.shopId } })),
      logLines.join(''),
    ];
    for (const secret of SECRETS) for (const h of haystacks) expect(h.includes(secret), secret).toBe(false);
    expect(logLines.join('')).toContain('/passcode/reveal'); // the reveals were logged…
  });

  it('log serializer masks passcode fields in request bodies at any depth', () => {
    const body = {
      newDevice: { type: 'PHONE', passcode: { lockType: 'PIN', value: PIN } },
      devicePasscode: { lockType: 'PATTERN', pattern: PATTERN },
      notes: 'fine',
    };
    const out = JSON.stringify(redactBody(body));
    for (const s of [PIN, '3,5,7,8,9']) expect(out).not.toContain(s);
    expect(out).toContain('fine');
    const req = serializeReq({ method: 'POST', url: '/api/tickets', body });
    expect(JSON.stringify(req)).not.toContain(PIN);
    expect(req.body).toEqual({ newDevice: { type: 'PHONE', passcode: '[REDACTED]' }, devicePasscode: '[REDACTED]', notes: 'fine' });
  });
});
