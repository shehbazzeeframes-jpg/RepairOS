/** Story §5: clock in/out, timesheets (timezone + DST), CSV export, corrections (D5, D8). */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { TimeclockStatus, TimeEntry, TimesheetResponse } from '@repairos/contracts';
import { PrismaClient, type TimeEntrySource } from '@repairos/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, auditOf, ownerWithShop } from './fixtures';
import { createTestApp } from './helpers';

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

function entry(shopId: string, userId: string, clockInAt: string, clockOutAt: string | null, source: TimeEntrySource = 'SELF') {
  return adminDb.timeEntry.create({
    data: { shopId, userId, clockInAt: new Date(clockInAt), clockOutAt: clockOutAt ? new Date(clockOutAt) : null, source },
  });
}

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const H = 3_600_000;

describe('self clock in/out (C1)', () => {
  it('opens and closes an entry at server time; 409s; not audited', async () => {
    const owner = await ownerWithShop(app);
    const tech = await addMember(app, adminDb, owner.shopId, 'TECHNICIAN');

    const before = Date.now();
    const inRes = TimeclockStatus.parse((await tech.agent.post('/api/timeclock/clock-in').send({ clockInAt: '2020-01-01T00:00:00Z' }).expect(200)).body);
    expect(inRes.openEntry).not.toBeNull();
    expect(Date.parse(inRes.openEntry!.clockInAt)).toBeGreaterThanOrEqual(before - 1000); // client timestamps ignored
    expect(inRes.openEntry).toMatchObject({ source: 'SELF', clockOutAt: null, stillOpen: false, flaggedLong: false });

    const again = await tech.agent.post('/api/timeclock/clock-in');
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'ALREADY_CLOCKED_IN', message: "You're already clocked in." });

    const out = TimeclockStatus.parse((await tech.agent.post('/api/timeclock/clock-out').expect(200)).body);
    expect(out.openEntry).toBeNull();
    expect(out.recentEntries).toHaveLength(1);
    expect(out.recentEntries[0]!.clockOutAt).not.toBeNull();
    expect(out.todayMinutes).toBeGreaterThanOrEqual(0);

    const notIn = await tech.agent.post('/api/timeclock/clock-out');
    expect(notIn.status).toBe(409);
    expect(notIn.body.code).toBe('NOT_CLOCKED_IN');
    expect((await auditOf(adminDb, owner.shopId)).filter((a) => a.action.startsWith('time_entry'))).toEqual([]);
  });

  it('parallel clock-ins create exactly one open entry', async () => {
    const owner = await ownerWithShop(app);
    const results = await Promise.all([1, 2, 3, 4].map(() => owner.agent.post('/api/timeclock/clock-in')));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409 && r.body.code === 'ALREADY_CLOCKED_IN')).toHaveLength(3);
    expect(await adminDb.timeEntry.count({ where: { shopId: owner.shopId, clockOutAt: null } })).toBe(1);
  });

  it('me: today minutes, this + last week only, long-shift/still-open flags; per shop', async () => {
    const owner = await ownerWithShop(app, { country: 'PK' });
    await entry(owner.shopId, owner.userId, iso(40 * 24 * H), iso(40 * 24 * H - H)); // too old
    await entry(owner.shopId, owner.userId, iso(30 * H), null); // open since > 14h, started yesterday
    const me = TimeclockStatus.parse((await owner.agent.get('/api/timeclock/me').expect(200)).body);
    expect(me.recentEntries).toHaveLength(1);
    expect(me.openEntry).toMatchObject({ flaggedLong: true, stillOpen: true });
    expect(me.openEntry!.durationMinutes).toBeGreaterThanOrEqual(30 * 60 - 1);

    // a second shop has its own clock
    await owner.agent.post('/api/shops').send({ name: 'Second', country: 'PK' }).expect(201);
    const other = TimeclockStatus.parse((await owner.agent.get('/api/timeclock/me').expect(200)).body);
    expect(other.openEntry).toBeNull();
    await owner.agent.post('/api/timeclock/clock-in').expect(200);
  });
});

describe('timesheets (C2) with shop timezone day boundaries', () => {
  it('PK: an entry belongs to the shop-local day it started on; totals; flags; needsReview', async () => {
    const owner = await ownerWithShop(app, { country: 'PK', name: 'Pak Owner' });
    const tech = await addMember(app, adminDb, owner.shopId, 'TECHNICIAN', 'Ali Tech');
    // 2026-11-10 23:30 PKT → 11-10; 2026-11-11 00:30 PKT → 11-11 (overnight, not split)
    await entry(owner.shopId, tech.userId, '2026-11-10T18:30:00Z', '2026-11-10T22:30:00Z'); // 4h on 11-10
    await entry(owner.shopId, tech.userId, '2026-11-10T19:30:00Z', '2026-11-11T11:00:00Z'); // 15h30 on 11-11 → long
    await entry(owner.shopId, owner.userId, '2026-11-12T04:00:00Z', '2026-11-12T12:52:00Z'); // 8h52

    const day = TimesheetResponse.parse((await owner.agent.get('/api/timesheets?from=2026-11-11&to=2026-11-11').expect(200)).body);
    expect(day.timezone).toBe('Asia/Karachi');
    expect(day.staff).toHaveLength(1);
    expect(day.staff[0]!.days).toEqual([
      expect.objectContaining({ date: '2026-11-11', totalMinutes: 930, entries: [expect.objectContaining({ flaggedLong: true, localDate: '2026-11-11' })] }),
    ]);
    expect(day.needsReviewCount).toBe(1);

    const week = TimesheetResponse.parse((await owner.agent.get('/api/timesheets?from=2026-11-09&to=2026-11-15').expect(200)).body);
    expect(week.staff.map((s) => [s.name, s.totalMinutes, s.days.map((d) => d.date)])).toEqual([
      ['Ali Tech', 240 + 930, ['2026-11-10', '2026-11-11']],
      ['Pak Owner', 532, ['2026-11-12']],
    ]);
    const review = TimesheetResponse.parse((await owner.agent.get('/api/timesheets?from=2026-11-09&to=2026-11-15&needsReview=true').expect(200)).body);
    expect(review.staff.flatMap((s) => s.days.flatMap((d) => d.entries)).map((e) => e.durationMinutes)).toEqual([930]);
    const onlyOwner = TimesheetResponse.parse((await owner.agent.get(`/api/timesheets?from=2026-11-09&to=2026-11-15&userId=${owner.userId}`).expect(200)).body);
    expect(onlyOwner.staff.map((s) => s.userId)).toEqual([owner.userId]);
  });

  it('US: DST day boundaries and real elapsed duration across the clock change', async () => {
    const owner = await ownerWithShop(app, { country: 'US' }); // America/New_York
    // 2026-03-07 22:00 EST → 2026-03-08 08:00 EDT: 9h elapsed (wall clock says 10h); belongs to 03-07
    await entry(owner.shopId, owner.userId, '2026-03-08T03:00:00Z', '2026-03-08T12:00:00Z');
    // 2026-03-08 23:30 EDT = 03-09T03:30Z → still 03-08 locally
    await entry(owner.shopId, owner.userId, '2026-03-09T03:30:00Z', '2026-03-09T04:00:00Z');
    // 2026-03-09 00:30 EDT = 04:30Z → 03-09
    await entry(owner.shopId, owner.userId, '2026-03-09T04:30:00Z', '2026-03-09T05:00:00Z');

    const res = TimesheetResponse.parse((await owner.agent.get('/api/timesheets?from=2026-03-07&to=2026-03-09').expect(200)).body);
    expect(res.staff[0]!.days.map((d) => [d.date, d.totalMinutes])).toEqual([
      ['2026-03-07', 540],
      ['2026-03-08', 30],
      ['2026-03-09', 30],
    ]);
    const only8 = TimesheetResponse.parse((await owner.agent.get('/api/timesheets?from=2026-03-08&to=2026-03-08').expect(200)).body);
    expect(only8.staff[0]!.days.map((d) => d.date)).toEqual(['2026-03-08']);

    // Changing the timezone re-displays past entries in the new zone; nothing is rewritten.
    await owner.agent.patch('/api/shop').send({ timezone: 'America/Los_Angeles' }).expect(200);
    const la = TimesheetResponse.parse((await owner.agent.get('/api/timesheets?from=2026-03-07&to=2026-03-09').expect(200)).body);
    expect(la.timezone).toBe('America/Los_Angeles');
    expect(la.staff[0]!.days.map((d) => d.date)).toEqual(['2026-03-07', '2026-03-08']);
  });

  it('includes deactivated people with entries; range limits are enforced (93 days)', async () => {
    const owner = await ownerWithShop(app);
    const tech = await addMember(app, adminDb, owner.shopId, 'TECHNICIAN', 'Gone Tech');
    await entry(owner.shopId, tech.userId, '2026-10-05T14:00:00Z', '2026-10-05T18:00:00Z');
    await owner.agent.post(`/api/staff/${tech.membershipId}/deactivate`).expect(200);
    const res = TimesheetResponse.parse((await owner.agent.get('/api/timesheets?from=2026-10-01&to=2026-10-31').expect(200)).body);
    expect(res.staff[0]).toMatchObject({ name: 'Gone Tech', status: 'DEACTIVATED', totalMinutes: 240 });

    expect((await owner.agent.get('/api/timesheets?from=2026-01-01&to=2026-04-03')).status).toBe(200); // 93 days
    const tooLong = await owner.agent.get('/api/timesheets?from=2026-01-01&to=2026-04-04');
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.issues[0].path).toEqual(['to']);
    expect((await owner.agent.get('/api/timesheets?from=2026-02-01&to=2026-01-01')).status).toBe(400);
    expect((await owner.agent.get('/api/timesheets?from=2026-02-30&to=2026-03-01')).status).toBe(400);
    expect((await owner.agent.get('/api/timesheets/export.csv?from=2026-01-01&to=2026-04-04')).status).toBe(400);
  });
});

describe('CSV export (C4)', () => {
  it('BOM, filename, columns, shop-local times, flags, escaping against formula injection; audited', async () => {
    const owner = await ownerWithShop(app, { country: 'PK', shopName: 'Lahore Mobile Clinic' });
    const evil = await addMember(app, adminDb, owner.shopId, 'TECHNICIAN', "=HYPERLINK(\"http://x\",\"y\")");
    const plus = await addMember(app, adminDb, owner.shopId, 'FRONT_DESK', '+92 Plus');
    const minus = await addMember(app, adminDb, owner.shopId, 'TECHNICIAN', '-Minus, Person');
    const at = await addMember(app, adminDb, owner.shopId, 'TECHNICIAN', '@SUM(A1)');
    await entry(owner.shopId, evil.userId, '2026-11-10T19:30:00Z', '2026-11-11T11:00:00Z');
    await entry(owner.shopId, plus.userId, '2026-11-11T04:00:00Z', '2026-11-11T12:52:00Z');
    await entry(owner.shopId, minus.userId, '2026-11-11T05:00:00Z', '2026-11-11T06:00:00Z');
    await entry(owner.shopId, at.userId, '2026-11-11T05:00:00Z', '2026-11-11T05:30:00Z');
    const fixed = await owner.agent
      .patch(`/api/time-entries/${(await adminDb.timeEntry.findFirstOrThrow({ where: { userId: at.userId } })).id}`)
      .send({ clockOutAt: '2026-11-11T06:00:00Z', reason: '=cmd forgot, to "clock out"' })
      .expect(200);
    expect(TimeEntry.parse(fixed.body).edited?.reason).toBe('=cmd forgot, to "clock out"');

    const res = await owner.agent.get('/api/timesheets/export.csv?from=2026-11-11&to=2026-11-11').expect(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="timesheet-lahore-mobile-clinic-2026-11-11-2026-11-11.csv"');
    const body = res.text;
    expect(body.charCodeAt(0)).toBe(0xfeff);
    const lines = body.slice(1).split('\r\n');
    expect(lines[0]).toBe('Staff name,Email,Role,Date,Clock in,Clock out,Duration (hours),Duration (minutes),Flags,Edited,Edit reason');
    expect(lines.at(-1)).toBe('');
    const rows = lines.slice(1, -1);
    expect(rows).toHaveLength(4);
    expect(rows).toContain(`'+92 Plus,${plus.email},Front desk,2026-11-11,09:00,17:52,8.87,532,,No,`);
    expect(rows).toContain(`"'=HYPERLINK(""http://x"",""y"")",${evil.email},Technician,2026-11-11,00:30,16:00,15.50,930,Long shift,No,`);
    expect(rows).toContain(`"'-Minus, Person",${minus.email},Technician,2026-11-11,10:00,11:00,1.00,60,,No,`);
    expect(rows).toContain(`'@SUM(A1),${at.email},Technician,2026-11-11,10:00,11:00,1.00,60,,Yes,"'=cmd forgot, to ""clock out"""`);

    const [audit] = await auditOf(adminDb, owner.shopId, 'timesheet.exported');
    expect(audit).toMatchObject({ entityType: 'Shop', entityId: owner.shopId, after: { from: '2026-11-11', to: '2026-11-11', userId: null } });
    expect(JSON.stringify(audit)).not.toContain('HYPERLINK');
  });

  it('BUG-02: prefetch requests get 204 and write no audit event; a real click still exports', async () => {
    const owner = await ownerWithShop(app);
    const url = '/api/timesheets/export.csv?from=2026-11-11&to=2026-11-11';
    const prefetches: Record<string, string>[] = [
      { 'Next-Router-Prefetch': '1' },
      { 'Next-Router-Prefetch': '1', RSC: '1' },
      { Purpose: 'prefetch' },
      { 'Sec-Purpose': 'prefetch' },
      { 'Sec-Purpose': 'prefetch;prerender' },
      { 'X-Moz': 'prefetch' },
    ];
    for (const headers of prefetches) {
      const res = await owner.agent.get(url).set(headers);
      expect(res.status).toBe(204);
      expect(res.text).toBe('');
    }
    // Next's second prefetch had no range at all: still 204, not a 400 or an export.
    expect((await owner.agent.get('/api/timesheets/export.csv?_rsc=abc').set('Next-Router-Prefetch', '1')).status).toBe(204);
    expect(await auditOf(adminDb, owner.shopId, 'timesheet.exported')).toHaveLength(0);

    await owner.agent.get(url).expect(200);
    expect(await auditOf(adminDb, owner.shopId, 'timesheet.exported')).toHaveLength(1);
    // Permission is still checked first: a Technician's prefetch is a 403, not a 204.
    const tech = await addMember(app, adminDb, owner.shopId, 'TECHNICIAN');
    expect((await tech.agent.get(url).set('Next-Router-Prefetch', '1')).status).toBe(403);
  });

  it('open entries have an empty clock-out and the "Still open" flag', async () => {
    const owner = await ownerWithShop(app);
    await entry(owner.shopId, owner.userId, iso(26 * H), null);
    const from = new Date(Date.now() - 3 * 24 * H).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 24 * H).toISOString().slice(0, 10);
    const res = await owner.agent.get(`/api/timesheets/export.csv?from=${from}&to=${to}`).expect(200);
    const row = res.text.split('\r\n')[1]!;
    expect(row).toMatch(/,,\d+\.\d{2},\d+,Long shift; Still open,No,$/);
  });
});

describe('corrections (C3, D5)', () => {
  it('owner adds, fixes and deletes entries with a reason; validation; audits', async () => {
    const owner = await ownerWithShop(app);
    const tech = await addMember(app, adminDb, owner.shopId, 'TECHNICIAN');

    const created = TimeEntry.parse(
      (
        await owner.agent
          .post('/api/time-entries')
          .send({ userId: tech.userId, clockInAt: '2026-11-02T14:00:00Z', clockOutAt: '2026-11-02T22:00:00Z', reason: 'Forgot to clock in' })
          .expect(201)
      ).body,
    );
    expect(created).toMatchObject({ source: 'MANUAL', durationMinutes: 480, edited: { reason: 'Forgot to clock in', byUserId: owner.userId, byName: 'Olivia Owner' } });
    expect((await auditOf(adminDb, owner.shopId, 'time_entry.created'))[0]).toMatchObject({
      entityId: created.id,
      after: { userId: tech.userId, clockInAt: '2026-11-02T14:00:00.000Z', clockOutAt: '2026-11-02T22:00:00.000Z', reason: 'Forgot to clock in' },
    });

    const overlap = await owner.agent
      .post('/api/time-entries')
      .send({ userId: tech.userId, clockInAt: '2026-11-02T21:00:00Z', clockOutAt: '2026-11-02T23:00:00Z', reason: 'Double' });
    expect(overlap.status).toBe(409);
    expect(overlap.body.code).toBe('TIME_ENTRY_OVERLAP');
    // touching boundaries is fine
    await owner.agent
      .post('/api/time-entries')
      .send({ userId: tech.userId, clockInAt: '2026-11-02T22:00:00Z', clockOutAt: '2026-11-02T23:00:00Z', reason: 'Late job' })
      .expect(201);

    const future = await owner.agent
      .post('/api/time-entries')
      .send({ userId: tech.userId, clockInAt: iso(-H), clockOutAt: iso(-2 * H), reason: 'Future' });
    expect(future.status).toBe(400);
    for (const body of [
      { userId: tech.userId, clockInAt: '2026-11-03T10:00:00Z', clockOutAt: '2026-11-04T10:01:00Z', reason: 'Too long' },
      { userId: tech.userId, clockInAt: '2026-11-03T10:00:00Z', clockOutAt: '2026-11-03T09:00:00Z', reason: 'Backwards' },
      { userId: tech.userId, clockInAt: '2026-11-03T10:00:00Z', clockOutAt: '2026-11-03T11:00:00Z', reason: 'x' },
    ]) {
      expect((await owner.agent.post('/api/time-entries').send(body)).status, body.reason).toBe(400);
    }
    const stranger = await owner.agent
      .post('/api/time-entries')
      .send({ userId: 'not-a-member', clockInAt: '2026-11-03T10:00:00Z', clockOutAt: '2026-11-03T11:00:00Z', reason: 'Who?' });
    expect(stranger.status).toBe(404);

    // fix: reason required; closing an open entry by setting clock-out
    expect((await owner.agent.patch(`/api/time-entries/${created.id}`).send({ clockInAt: '2026-11-02T13:00:00Z' })).status).toBe(400);
    const fixed = TimeEntry.parse(
      (await owner.agent.patch(`/api/time-entries/${created.id}`).send({ clockInAt: '2026-11-02T13:00:00Z', reason: 'Started earlier' }).expect(200)).body,
    );
    expect(fixed.durationMinutes).toBe(540);
    expect((await auditOf(adminDb, owner.shopId, 'time_entry.updated'))[0]).toMatchObject({
      before: { clockInAt: '2026-11-02T14:00:00.000Z' },
      after: { clockInAt: '2026-11-02T13:00:00.000Z', reason: 'Started earlier' },
    });
    const open = await entry(owner.shopId, tech.userId, iso(5 * H), null);
    const closed = TimeEntry.parse(
      (await owner.agent.patch(`/api/time-entries/${open.id}`).send({ clockOutAt: iso(H), reason: 'Forgot to clock out' }).expect(200)).body,
    );
    expect(closed.clockOutAt).not.toBeNull();

    // delete with reason: hard delete, before snapshot in audit
    expect((await owner.agent.delete(`/api/time-entries/${created.id}`).send({})).status).toBe(400);
    await owner.agent.delete(`/api/time-entries/${created.id}`).send({ reason: 'Duplicate entry' }).expect(204);
    expect(await adminDb.timeEntry.findUnique({ where: { id: created.id } })).toBeNull();
    expect((await auditOf(adminDb, owner.shopId, 'time_entry.deleted'))[0]).toMatchObject({
      entityId: created.id,
      before: { userId: tech.userId, clockInAt: '2026-11-02T13:00:00.000Z', reason: 'Duplicate entry' },
      after: null,
    });
    expect((await owner.agent.delete(`/api/time-entries/${created.id}`).send({ reason: 'Again' })).status).toBe(404);
  });

  it('D5: a Manager fixes FD/T/other Managers but not their own or an Owner\'s; Owner fixes their own', async () => {
    const owner = await ownerWithShop(app);
    const manager = await addMember(app, adminDb, owner.shopId, 'MANAGER');
    const manager2 = await addMember(app, adminDb, owner.shopId, 'MANAGER');
    const fd = await addMember(app, adminDb, owner.shopId, 'FRONT_DESK');
    const slot = (h: number) => ({ clockInAt: `2026-11-0${h}T10:00:00Z`, clockOutAt: `2026-11-0${h}T11:00:00Z`, reason: 'Missing' });

    await manager.agent.post('/api/time-entries').send({ userId: fd.userId, ...slot(1) }).expect(201);
    await manager.agent.post('/api/time-entries').send({ userId: manager2.userId, ...slot(1) }).expect(201);
    for (const userId of [manager.userId, owner.userId]) {
      const res = await manager.agent.post('/api/time-entries').send({ userId, ...slot(2) });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    }
    const own = await entry(owner.shopId, manager.userId, '2026-11-03T10:00:00Z', '2026-11-03T11:00:00Z');
    expect((await manager.agent.patch(`/api/time-entries/${own.id}`).send({ clockOutAt: '2026-11-03T12:00:00Z', reason: 'Mine' })).status).toBe(403);
    expect((await manager.agent.delete(`/api/time-entries/${own.id}`).send({ reason: 'Mine' })).status).toBe(403);
    await owner.agent.patch(`/api/time-entries/${own.id}`).send({ clockOutAt: '2026-11-03T12:00:00Z', reason: 'Owner fix' }).expect(200);
    await owner.agent.post('/api/time-entries').send({ userId: owner.userId, ...slot(4) }).expect(201);
    expect((await fd.agent.post('/api/time-entries').send({ userId: fd.userId, ...slot(5) })).status).toBe(403);
  });
});
