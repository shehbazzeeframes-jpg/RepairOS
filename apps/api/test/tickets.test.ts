/**
 * Sprint 2 §5: check-in (nested creates, idempotency, gapless numbers), list views/filters/search/sort/cursor,
 * counts = dashboard, detail, edit + optimistic concurrency, status transition matrix, collect/cancel/reopen
 * window, warranty, notes, timeline mapping, assignees, and due dates in the shop timezone (DST).
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  CheckInContext,
  computeDefaultDueAt,
  DashboardSummary,
  STATUS_CATEGORIES,
  TicketCounts,
  TicketDetail,
  TicketListResponse,
  TicketNote,
  TimelineResponse,
  canTransition,
  type StatusCategory,
  AssigneesResponse,
  zonedTimeToUtc,
} from '@repairos/contracts';
import { PrismaClient } from '@repairos/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, auditOf, type Member, ownerWithShop, type OwnerWithShop } from './fixtures';
import { createTestApp } from './helpers';
import { checkInExisting, checkInNew, imei, newKey, statuses, usPhone } from './s2';

let app: NestExpressApplication;
let adminDb: PrismaClient;
let owner: OwnerWithShop;
let tech: Member;
let fd: Member;


beforeAll(async () => {
  app = await createTestApp();
  adminDb = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL_TEST });
  owner = await ownerWithShop(app, { shopName: 'Ticket Shop' });
  tech = await addMember(app, adminDb, owner.shopId, 'TECHNICIAN', 'Tess Tech');
  fd = await addMember(app, adminDb, owner.shopId, 'FRONT_DESK', 'Fran Desk');

});
afterAll(async () => {
  await adminDb?.$disconnect();
  await app?.close();
});

describe('check-in (TK1–TK4)', () => {
  it('creates customer, device and ticket in one transaction, in the INITIAL status, with default due and counters', async () => {
    const ctx = CheckInContext.parse((await fd.agent.get('/api/tickets/check-in-context').expect(200)).body);
    const t = TicketDetail.parse(await checkInNew(fd.agent, { firstName: 'Walk', lastName: 'In' }));
    expect(t.status.name).toBe('Received');
    expect(t.numberLabel).toBe(`T-${t.number}`);
    expect(t.customer.displayName).toBe('Walk In');
    expect(t.device.model).toBe('iPhone 13');
    expect(t.issues).toEqual([{ code: 'SCREEN_CRACKED', label: 'Screen cracked' }]);
    expect(Object.values(t.checklist).every((r) => r === 'UNTESTED')).toBe(true);
    expect(t.dueAt).toBe(ctx.defaultDue.dueAt);
    expect(t.dueHasTime).toBe(false);
    expect(t.createdBy?.name).toBe('Fran Desk');
    const c = await adminDb.customer.findUniqueOrThrow({ where: { id: t.customer.id } });
    expect(c.openTicketCount).toBe(1);
    expect(c.lastVisitAt?.toISOString()).toBe(t.createdAt);
    const events = await adminDb.ticketEvent.findMany({ where: { ticketId: t.id } });
    expect(events.map((e) => e.type)).toEqual(['created']);
  });

  it('a failed check-in leaves no customer, device or number behind', async () => {
    const before = await adminDb.shopTicketSettings.findFirstOrThrow({ where: { shopId: owner.shopId } });
    const customers = await adminDb.customer.count({ where: { shopId: owner.shopId } });
    const res = await fd.agent.post('/api/tickets').send({
      newCustomer: { firstName: 'Fail', phones: [{ number: usPhone() }] },
      newDevice: { type: 'PHONE', brand: 'Apple', model: 'X' },
      issues: [{ code: 'BATTERY' }],
      assigneeUserId: 'nobody',
    });
    expect(res.status).toBe(404);
    expect(await adminDb.customer.count({ where: { shopId: owner.shopId } })).toBe(customers);
    expect((await adminDb.shopTicketSettings.findFirstOrThrow({ where: { shopId: owner.shopId } })).nextNumber).toBe(before.nextNumber);
  });

  it('validates: customer/device choice, issue or description, checklist keys, currency, past due, archived customer', async () => {
    const base = await checkInNew(owner.agent);
    const send = (body: object) => owner.agent.post('/api/tickets').send(body);
    expect((await send({ issues: [{ code: 'BATTERY' }] })).status).toBe(400);
    expect((await send({ customerId: base.customer.id, deviceId: base.device.id })).body.issues[0].path).toEqual(['issues']);
    const badKey = await send({ customerId: base.customer.id, deviceId: base.device.id, issues: [{ code: 'BATTERY' }], checklist: { KEYBOARD: 'PASS' } });
    expect(badKey.status).toBe(400);
    expect(badKey.body.issues[0].path).toEqual(['checklist', 'KEYBOARD']);
    const cur = await send({ customerId: base.customer.id, deviceId: base.device.id, issues: [{ code: 'BATTERY' }], estimate: { amountMinor: 100, currency: 'GBP' } });
    expect(cur.body.issues[0].path).toEqual(['estimate', 'currency']);
    const past = await send({ customerId: base.customer.id, deviceId: base.device.id, issues: [{ code: 'BATTERY' }], dueDate: '2020-01-01' });
    expect(past.body.issues[0]).toMatchObject({ path: ['dueDate'], message: "Due date can't be in the past" });
    const other = await checkInNew(owner.agent);
    const wrongDevice = await send({ customerId: base.customer.id, deviceId: other.device.id, issues: [{ code: 'BATTERY' }] });
    expect(wrongDevice.status).toBe(400);
    // Archived customer → 409 CUSTOMER_ARCHIVED ("Restore and use")
    const lonely = (await owner.agent.post('/api/customers').send({ firstName: 'Arch', phones: [{ number: usPhone() }] }).expect(201)).body;
    const dev = (await owner.agent.post(`/api/customers/${lonely.id}/devices`).send({ type: 'LAPTOP', brand: 'Dell', model: 'XPS 13' }).expect(201)).body;
    await owner.agent.post(`/api/customers/${lonely.id}/archive`).expect(200);
    const archived = await send({ customerId: lonely.id, deviceId: dev.id, issues: [{ code: 'KEYBOARD' }] });
    expect(archived.status).toBe(409);
    expect(archived.body.code).toBe('CUSTOMER_ARCHIVED');
  });

  it('technicians cannot check in; nested customer/device needs customers.manage', async () => {
    const res = await tech.agent.post('/api/tickets').send({});
    expect(res.status).toBe(403);
  });

  it('Idempotency-Key: a repeat returns the same ticket (200) without a second number; bad key → 400', async () => {
    const key = newKey();
    const first = await checkInNew(fd.agent, { key });
    const again = await fd.agent.post('/api/tickets').set('Idempotency-Key', key).send({ anything: true });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.id);
    // Concurrent duplicates also collapse into one ticket.
    const key2 = newKey();
    const body = {
      newCustomer: { firstName: 'Double', phones: [{ number: usPhone() }] },
      newDevice: { type: 'PHONE', brand: 'Apple', model: 'iPhone 12' },
      issues: [{ code: 'BATTERY' }],
    };
    const results = await Promise.all([1, 2, 3].map(() => fd.agent.post('/api/tickets').set('Idempotency-Key', key2).send(body)));
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    expect(await adminDb.customer.count({ where: { shopId: owner.shopId, firstName: 'Double' } })).toBe(1);
    // Another user with the same key gets their own ticket.
    const mine = await checkInNew(owner.agent, { key });
    expect(mine.id).not.toBe(first.id);
    // Outside the window the key creates a new ticket.
    await adminDb.ticketIdempotencyKey.updateMany({ where: { key }, data: { createdAt: new Date(Date.now() - 11 * 60_000) } });
    const later = await checkInNew(fd.agent, { key });
    expect(later.id).not.toBe(first.id);
    expect((await fd.agent.post('/api/tickets').set('Idempotency-Key', 'not-a-uuid').send({})).status).toBe(400);
  });

  it('20 concurrent check-ins (with failures mixed in) get gapless, unique numbers', async () => {
    const shop = await ownerWithShop(app, { shopName: 'Busy Shop' });
    const seed = await checkInNew(shop.agent);
    const ok = Array.from({ length: 20 }, () => checkInExisting(shop.agent, seed.customer.id, seed.device.id).then((t) => t.number));
    const failing = Array.from({ length: 5 }, () =>
      shop.agent.post('/api/tickets').send({ customerId: seed.customer.id, deviceId: seed.device.id, issues: [{ code: 'BATTERY' }], assigneeUserId: 'ghost' }),
    );
    const [numbers, failures] = await Promise.all([Promise.all(ok), Promise.all(failing)]);
    expect(failures.every((f) => f.status === 404)).toBe(true);
    const all = [seed.number, ...numbers].sort((a, b) => a - b);
    expect(all).toEqual(Array.from({ length: 21 }, (_, i) => 1001 + i));
    const c = await adminDb.customer.findUniqueOrThrow({ where: { id: seed.customer.id } });
    expect(c.openTicketCount).toBe(21);
  });

  it('existing device: devicePasscode sets the passcode (audited, lock type only); new device passcode too', async () => {
    const t = await checkInNew(fd.agent, { passcode: undefined });
    const res = await fd.agent
      .post('/api/tickets')
      .send({ customerId: t.customer.id, deviceId: t.device.id, issues: [{ code: 'BATTERY' }], devicePasscode: { lockType: 'PIN', value: '0042' } })
      .expect(201);
    expect(res.body.device).toMatchObject({ lockType: 'PIN', passcodeOnFile: true });
    const audits = await auditOf(adminDb, owner.shopId, 'device.passcode_changed');
    const mine = audits.filter((a) => a.entityId === t.device.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.after).toEqual({ lockType: 'PIN' });
    expect(JSON.stringify(mine[0])).not.toContain('0042');
  });
});

describe('views, filters, search, sort, cursor, counts = dashboard (TL1, DB1)', () => {
  let shop: OwnerWithShop;
  let st: Record<string, { id: string; category: string }>;
  let techM: Member;
  const ids = {} as Record<'a' | 'b' | 'c' | 'd', TicketDetail>;

  beforeAll(async () => {
    shop = await ownerWithShop(app, { shopName: 'Views Shop' });
    st = await statuses(shop.agent);
    techM = await addMember(app, adminDb, shop.shopId, 'TECHNICIAN', 'Vic Tech');
    ids.a = await checkInNew(shop.agent, { firstName: 'Ali', lastName: 'Khan', phone: '+12122003456', imei: imei(42) });
    ids.b = await checkInNew(shop.agent, { firstName: 'Bea', lastName: 'Smith', extra: { priority: 'URGENT', assigneeUserId: techM.userId } });
    ids.c = await checkInNew(shop.agent, { firstName: 'Cid', lastName: 'Jones' });
    ids.d = await checkInNew(shop.agent, { firstName: 'Dee', lastName: 'Brown' });
    // c → ready; d → collected
    await shop.agent.post(`/api/tickets/${ids.c.id}/status`).send({ statusId: st['Ready for pickup']!.id }).expect(200);
    await shop.agent.post(`/api/tickets/${ids.d.id}/status`).send({ statusId: st['Ready for pickup']!.id }).expect(200);
    await shop.agent.post(`/api/tickets/${ids.d.id}/status`).send({ statusId: st.Collected!.id }).expect(200);
    // a overdue
    await adminDb.ticket.update({ where: { id: ids.a.id }, data: { dueAt: new Date(Date.now() - 3_600_000) } });
  });

  const list = async (qs: string, agent = shop.agent) => TicketListResponse.parse((await agent.get(`/api/tickets?${qs}`).expect(200)).body);

  it('views match contracts ticketInView', async () => {
    expect((await list('view=open')).items.map((i) => i.numberLabel)).toEqual([ids.b, ids.a, ids.c].map((t) => t.numberLabel)); // urgent first, then due
    expect((await list('view=closed')).items.map((i) => i.id)).toEqual([ids.d.id]);
    expect((await list('view=ready')).items.map((i) => i.id)).toEqual([ids.c.id]);
    expect((await list('view=overdue')).items.map((i) => i.id)).toEqual([ids.a.id]);
    expect((await list('view=unassigned')).items.map((i) => i.id).sort()).toEqual([ids.a.id].sort());
    expect((await list('view=mine', techM.agent)).items.map((i) => i.id)).toEqual([ids.b.id]);
    expect((await list('view=all')).total).toBe(4);
    const a = (await list('view=overdue')).items[0]!;
    expect(a).toMatchObject({ isOverdue: true, customer: { displayName: 'Ali Khan', primaryPhone: '+12122003456' }, issues: ['Screen cracked'] });
  });

  it('filters and search (number, name any order, phone any format, IMEI last digits)', async () => {
    expect((await list(`view=all&priority=URGENT`)).items.map((i) => i.id)).toEqual([ids.b.id]);
    expect((await list(`view=all&assignee=unassigned&category=OPEN`)).items.map((i) => i.id)).toEqual([ids.a.id]);
    expect((await list(`view=all&status=${st.Collected!.id}`)).items.map((i) => i.id)).toEqual([ids.d.id]);
    expect((await list(`view=all&q=${encodeURIComponent(ids.c.numberLabel.toLowerCase().replace('-', ''))}`)).items.map((i) => i.id)).toEqual([ids.c.id]);
    expect((await list(`view=all&q=khan%20ali`)).items.map((i) => i.id)).toEqual([ids.a.id]);
    expect((await list(`view=all&q=${encodeURIComponent('(212) 200-3456')}`)).items.map((i) => i.id)).toEqual([ids.a.id]);
    expect((await list(`view=all&q=3456`)).items.map((i) => i.id)).toEqual([ids.a.id]);
    expect((await list(`view=all&q=${imei(42).slice(-6)}`)).items.map((i) => i.id)).toEqual([ids.a.id]);
    expect((await list(`view=all&deviceType=LAPTOP`)).items).toEqual([]);
    expect((await list(`view=all&customerId=${ids.b.customer.id}`)).items.map((i) => i.id)).toEqual([ids.b.id]);
    expect((await shop.agent.get('/api/tickets?cursor=garbage')).status).toBe(400);
  });

  it('every sort walks all pages without gaps or repeats', async () => {
    for (const sort of ['default', 'due', 'created', 'updated', 'number', 'closed', 'open_first']) {
      const seen: string[] = [];
      let cursor: string | null = null;
      // limit must be 25/50/100: create pages through the internal list with 25 and the 4 tickets → one page;
      // use the API's keyset by checking the cursor round-trip on a single-item page via view=all&limit=25.
      do {
        const page: TicketListResponse = await list(`view=all&sort=${sort}&limit=25${cursor ? `&cursor=${cursor}` : ''}`);
        seen.push(...page.items.map((i) => i.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(new Set(seen).size, sort).toBe(4);
      expect(seen.length, sort).toBe(4);
    }
    expect((await list('view=all&sort=number')).items.map((i) => i.number)).toEqual([ids.d, ids.c, ids.b, ids.a].map((t) => t.number));
    expect((await list('view=all&sort=open_first')).items.at(-1)!.id).toBe(ids.d.id);
  });

  it('keyset pagination over 30 tickets (limit 25)', async () => {
    const s2 = await ownerWithShop(app, { shopName: 'Paging Shop' });
    const first = await checkInNew(s2.agent);
    for (let i = 0; i < 29; i++) await checkInExisting(s2.agent, first.customer.id, first.device.id, { priority: i % 3 ? 'NORMAL' : 'URGENT' });
    for (const sort of ['default', 'number', 'created', 'due', 'open_first']) {
      const p1 = TicketListResponse.parse((await s2.agent.get(`/api/tickets?view=open&sort=${sort}&limit=25`).expect(200)).body);
      expect(p1.items).toHaveLength(25);
      expect(p1).toMatchObject({ total: 30, totalCapped: false });
      const p2 = TicketListResponse.parse((await s2.agent.get(`/api/tickets?view=open&sort=${sort}&limit=25&cursor=${p1.nextCursor}`).expect(200)).body);
      expect(p2.items).toHaveLength(5);
      expect(p2.nextCursor).toBeNull();
      expect(new Set([...p1.items, ...p2.items].map((i) => i.id)).size).toBe(30);
    }
  });

  it('counts agree with the views and the dashboard tiles', async () => {
    const counts = TicketCounts.parse((await shop.agent.get('/api/tickets/counts').expect(200)).body);
    expect(counts).toMatchObject({ open: 3, ready: 1, overdue: 1, unassigned: 1, openAndWaiting: 2, mine: 0 });
    for (const view of ['open', 'ready', 'overdue', 'unassigned'] as const) expect((await list(`view=${view}`)).total, view).toBe(counts[view]);
    const dash = DashboardSummary.parse((await shop.agent.get('/api/dashboard').expect(200)).body);
    expect({ ...dash.counts, serverNow: '' }).toEqual({ ...counts, serverNow: '' });
    expect(dash.myQueue).toEqual([]);
    expect(dash.unassigned.map((i) => i.id)).toEqual([ids.a.id]);
    const techDash = DashboardSummary.parse((await techM.agent.get('/api/dashboard').expect(200)).body);
    expect(techDash.myQueue.map((i) => i.id)).toEqual([ids.b.id]);
    expect(techDash.myQueueTotal).toBe(1);
    expect(techDash.unassigned).toEqual([]);
  });

  it('status category changes keep the views right (FK cascade); deactivated assignee counts as unassigned', async () => {
    const custom = (await shop.agent.post('/api/ticket-statuses').send({ name: 'Bench', category: 'OPEN', colour: 'blue' }).expect(201)).body;
    await shop.agent.post(`/api/tickets/${ids.b.id}/status`).send({ statusId: custom.id }).expect(200);
    await shop.agent.patch(`/api/ticket-statuses/${custom.id}`).send({ category: 'READY' }).expect(200);
    expect((await list('view=ready')).items.map((i) => i.id).sort()).toEqual([ids.b.id, ids.c.id].sort());
    const blocked = await shop.agent.patch(`/api/ticket-statuses/${custom.id}`).send({ category: 'CLOSED' });
    expect(blocked.body.code).toBe('STATUS_IN_USE');
    await shop.agent.patch(`/api/ticket-statuses/${custom.id}`).send({ category: 'OPEN' }).expect(200);
    await adminDb.membership.update({ where: { id: techM.membershipId }, data: { status: 'DEACTIVATED' } });
    try {
      expect((await list('view=unassigned')).items.map((i) => i.id).sort()).toEqual([ids.a.id, ids.b.id].sort());
      const counts = TicketCounts.parse((await shop.agent.get('/api/tickets/counts').expect(200)).body);
      expect(counts.unassigned).toBe(2);
      const item = (await list('view=unassigned')).items.find((i) => i.id === ids.b.id)!;
      expect(item.assignee).toMatchObject({ name: 'Vic Tech', active: false });
    } finally {
      await adminDb.membership.update({ where: { id: techM.membershipId }, data: { status: 'ACTIVE' } });
    }
  });
});

describe('status transitions (§5.4, A7) through the API', () => {
  it('matches canTransition for every (from category, target) pair and role', async () => {
    const st = await statuses(owner.agent);
    const targets = Object.entries(st);
    const fromStatus: Record<StatusCategory, string> = { OPEN: 'Diagnosing', WAITING: 'Awaiting parts', READY: 'Ready for pickup', CLOSED: 'Collected' };
    const people = { OWNER: owner, FRONT_DESK: fd, TECHNICIAN: tech };
    const statusRows = await adminDb.ticketStatus.findMany({ where: { shopId: owner.shopId } });
    for (const from of STATUS_CATEGORIES) {
      for (const [name, target] of targets) {
        for (const [role, person] of Object.entries(people) as [keyof typeof people, typeof owner][]) {
          // fresh ticket in the "from" status
          const t = await checkInNew(owner.agent, { imei: null });
          if (from !== 'OPEN' || fromStatus[from] !== 'Received') {
            if (from === 'CLOSED') {
              await owner.agent.post(`/api/tickets/${t.id}/status`).send({ statusId: st['Ready for pickup']!.id }).expect(200);
              await owner.agent.post(`/api/tickets/${t.id}/status`).send({ statusId: st.Collected!.id }).expect(200);
            } else {
              await owner.agent.post(`/api/tickets/${t.id}/status`).send({ statusId: st[fromStatus[from]]!.id }).expect(200);
            }
          }
          const row = statusRows.find((s) => s.id === target.id)!;
          const expected = canTransition(
            { category: from, id: st[fromStatus[from]]!.id },
            { id: row.id, category: row.category as StatusCategory, systemRole: row.systemRole, isHidden: row.isHidden, requiresNote: row.requiresNote },
            { role, via: 'status' },
          );
          const res = await person.agent
            .post(`/api/tickets/${t.id}/status`)
            .send({ statusId: target.id, ...(row.requiresNote ? { note: { body: 'Board is dead', visibility: 'CUSTOMER' } } : {}) });
          const label = `${role} ${from} → ${name}`;
          if (expected.ok) expect(res.status, label).toBe(200);
          else expect(res.body.code, label).toBe(expected.code);
        }
      }
    }
  }, 240_000);

  it('Unrepairable requires a note (posted as a note + status_changed with noteId); hidden → STATUS_HIDDEN; collect from open → message', async () => {
    const st = await statuses(owner.agent);
    const t = await checkInNew(owner.agent);
    const noNote = await owner.agent.post(`/api/tickets/${t.id}/status`).send({ statusId: st.Unrepairable!.id });
    expect(noNote.status).toBe(400);
    await owner.agent.post(`/api/tickets/${t.id}/status`).send({ statusId: st.Unrepairable!.id, note: { body: 'Logic board', visibility: 'CUSTOMER' } }).expect(200);
    const tl = TimelineResponse.parse((await owner.agent.get(`/api/tickets/${t.id}/timeline`).expect(200)).body);
    const changed = tl.items.find((i) => i.type === 'status_changed')!;
    const added = tl.items.find((i) => i.type === 'note_added')!;
    expect(changed.type === 'status_changed' && changed.data.noteId).toBe(added.type === 'note_added' && added.data.note.id);
    expect(changed.type === 'status_changed' && changed.data).toMatchObject({ from: { name: 'Received' }, to: { name: 'Unrepairable' }, notifyPending: true });

    const hidden = (await owner.agent.post('/api/ticket-statuses').send({ name: 'Shelf', category: 'WAITING', colour: 'yellow' }).expect(201)).body;
    await owner.agent.patch(`/api/ticket-statuses/${hidden.id}`).send({ isHidden: true }).expect(200);
    const r = await owner.agent.post(`/api/tickets/${t.id}/status`).send({ statusId: hidden.id });
    expect(r.body.code).toBe('STATUS_HIDDEN');
    const t2 = await checkInNew(owner.agent);
    const collect = await owner.agent.post(`/api/tickets/${t2.id}/status`).send({ statusId: st.Collected!.id });
    expect(collect.body).toMatchObject({ code: 'TRANSITION_NOT_ALLOWED', message: expect.stringMatching(/Ready for pickup first/) });
    // technician cannot collect: 403
    await owner.agent.post(`/api/tickets/${t2.id}/status`).send({ statusId: st['Ready for pickup']!.id }).expect(200);
    const techCollect = await tech.agent.post(`/api/tickets/${t2.id}/status`).send({ statusId: st.Collected!.id });
    expect(techCollect.status).toBe(403);
  });
});

describe('cancel, reopen window, warranty (TK-C, TK-R, TK-W)', () => {
  it('cancel needs reason (+ returned confirmation), closes, audits; counters follow', async () => {
    const t = await checkInNew(fd.agent);
    expect((await fd.agent.post(`/api/tickets/${t.id}/cancel`).send({ reason: 'CUSTOMER_DECLINED' })).status).toBe(400);
    expect((await fd.agent.post(`/api/tickets/${t.id}/cancel`).send({ reason: 'OTHER', returnedConfirmed: true })).status).toBe(400);
    expect((await tech.agent.post(`/api/tickets/${t.id}/cancel`).send({ reason: 'DUPLICATE' })).status).toBe(403);
    const res = TicketDetail.parse(
      (await fd.agent.post(`/api/tickets/${t.id}/cancel`).send({ reason: 'CUSTOMER_DECLINED', returnedConfirmed: true, note: 'Too pricey' }).expect(200)).body,
    );
    expect(res).toMatchObject({ status: { systemRole: 'CANCELLED' }, cancelReason: 'CUSTOMER_DECLINED', cancelNote: 'Too pricey', statusBeforeClose: { name: 'Received' } });
    expect(res.closedAt).not.toBeNull();
    expect((await adminDb.customer.findUniqueOrThrow({ where: { id: t.customer.id } })).openTicketCount).toBe(0);
    const audit = (await auditOf(adminDb, owner.shopId, 'ticket.cancelled')).find((a) => a.entityId === t.id)!;
    expect(audit.after).toMatchObject({ reason: 'CUSTOMER_DECLINED', returnedConfirmed: true });
    const again = await fd.agent.post(`/api/tickets/${t.id}/cancel`).send({ reason: 'DUPLICATE' });
    expect(again.body.code).toBe('TICKET_CLOSED');
    // edits on closed tickets are refused; notes are allowed
    expect((await fd.agent.patch(`/api/tickets/${t.id}`).send({ version: res.version, priority: 'URGENT' })).body.code).toBe('TICKET_CLOSED');
    await fd.agent.post(`/api/tickets/${t.id}/notes`).send({ body: 'Returned at the counter' }).expect(201);
  });

  it('reopen within 7 days (default target = status before close); after 7 days → REOPEN_WINDOW_PASSED', async () => {
    const st = await statuses(owner.agent);
    const t = await checkInNew(fd.agent);
    await fd.agent.post(`/api/tickets/${t.id}/status`).send({ statusId: st['In repair']!.id }).expect(200);
    await fd.agent.post(`/api/tickets/${t.id}/status`).send({ statusId: st['Ready for pickup']!.id }).expect(200);
    await fd.agent.post(`/api/tickets/${t.id}/status`).send({ statusId: st.Collected!.id }).expect(200);
    expect((await tech.agent.post(`/api/tickets/${t.id}/reopen`).send({ reason: 'Oops' })).status).toBe(403);
    expect((await fd.agent.post(`/api/tickets/${t.id}/reopen`).send({ reason: 'x' })).status).toBe(400);
    const reopened = TicketDetail.parse((await fd.agent.post(`/api/tickets/${t.id}/reopen`).send({ reason: 'Still broken' }).expect(200)).body);
    expect(reopened).toMatchObject({ status: { name: 'Ready for pickup' }, closedAt: null, reopenCount: 1, statusBeforeClose: null });
    expect((await adminDb.customer.findUniqueOrThrow({ where: { id: t.customer.id } })).openTicketCount).toBe(1);
    expect((await auditOf(adminDb, owner.shopId, 'ticket.reopened')).find((a) => a.entityId === t.id)?.after).toEqual({
      statusId: st['Ready for pickup']!.id,
      reason: 'Still broken',
    });
    // not closed → TRANSITION_NOT_ALLOWED
    expect((await fd.agent.post(`/api/tickets/${t.id}/reopen`).send({ reason: 'Again' })).body.code).toBe('TRANSITION_NOT_ALLOWED');
    // close again and age it past 7 days
    await fd.agent.post(`/api/tickets/${t.id}/status`).send({ statusId: st.Collected!.id }).expect(200);
    await adminDb.ticket.update({ where: { id: t.id }, data: { closedAt: new Date(Date.now() - 7 * 86_400_000 - 60_000) } });
    const late = await fd.agent.post(`/api/tickets/${t.id}/reopen`).send({ reason: 'Too late' });
    expect(late.body.code).toBe('REOPEN_WINDOW_PASSED');
    await adminDb.ticket.update({ where: { id: t.id }, data: { closedAt: new Date(Date.now() - 7 * 86_400_000 + 60_000) } });
    await fd.agent.post(`/api/tickets/${t.id}/reopen`).send({ reason: 'Just in time', statusId: st.Diagnosing!.id }).expect(200);
  });

  it('warranty ticket only for a collected original; links point at the root original', async () => {
    const st = await statuses(owner.agent);
    const t = await checkInNew(fd.agent);
    const notYet = await fd.agent.post('/api/tickets').send({ customerId: t.customer.id, deviceId: t.device.id, issues: [{ code: 'BATTERY' }], warrantyOfTicketId: t.id });
    expect(notYet.body.code).toBe('WARRANTY_NOT_ALLOWED');
    await fd.agent.post(`/api/tickets/${t.id}/status`).send({ statusId: st['Ready for pickup']!.id }).expect(200);
    await fd.agent.post(`/api/tickets/${t.id}/status`).send({ statusId: st.Collected!.id }).expect(200);
    const w1 = await checkInExisting(fd.agent, t.customer.id, t.device.id, { warrantyOfTicketId: t.id });
    expect(w1.warrantyOf?.id).toBe(t.id);
    await fd.agent.post(`/api/tickets/${w1.id}/status`).send({ statusId: st['Ready for pickup']!.id }).expect(200);
    await fd.agent.post(`/api/tickets/${w1.id}/status`).send({ statusId: st.Collected!.id }).expect(200);
    const w2 = await checkInExisting(fd.agent, t.customer.id, t.device.id, { warrantyOfTicketId: w1.id });
    expect(w2.warrantyOf?.id).toBe(t.id); // root
    const original = TicketDetail.parse((await fd.agent.get(`/api/tickets/${t.id}`).expect(200)).body);
    expect(original.warrantyTickets.map((w) => w.id)).toEqual([w2.id, w1.id]);
    const tl = TimelineResponse.parse((await fd.agent.get(`/api/tickets/${t.id}/timeline`).expect(200)).body);
    expect(tl.items.filter((i) => i.type === 'warranty_linked').map((i) => i.type === 'warranty_linked' && i.data.ticket.id)).toEqual([w1.id, w2.id]);
    expect((await fd.agent.get(`/api/tickets?view=all&warranty=true&customerId=${t.customer.id}`).expect(200)).body.total).toBe(2);
  });
});

describe('edit, assign, notes, timeline (TE1, AS1, TD1.5)', () => {
  it('PATCH writes one fields_changed event (checklist per item), bumps version; stale version → 409 STALE_RECORD', async () => {
    const t = await checkInNew(fd.agent);
    const res = TicketDetail.parse(
      (
        await tech.agent
          .patch(`/api/tickets/${t.id}`)
          .send({
            version: t.version,
            checklist: { SCREEN: 'FAIL', POWERS_ON: 'PASS' },
            priority: 'URGENT',
            estimate: { amountMinor: 12999, currency: 'USD' },
            issues: [{ code: 'SCREEN_CRACKED' }, { label: 'Bent frame' }],
            accessories: ['CASE', 'OTHER'],
            accessoriesOther: 'Stylus pen',
          })
          .expect(200)
      ).body,
    );
    expect(res.version).toBe(t.version + 1);
    expect(res).toMatchObject({ priority: 'URGENT', estimate: { amountMinor: 12999, currency: 'USD' }, accessories: ['CASE', 'OTHER'], accessoriesOther: 'Stylus pen' });
    expect(res.checklist).toMatchObject({ SCREEN: 'FAIL', POWERS_ON: 'PASS', FRONT_CAMERA: 'UNTESTED' });
    const tl = TimelineResponse.parse((await tech.agent.get(`/api/tickets/${t.id}/timeline`).expect(200)).body);
    const fc = tl.items.filter((i) => i.type === 'fields_changed');
    expect(fc).toHaveLength(1);
    const fields = fc[0]!.type === 'fields_changed' ? fc[0]!.data.changes.map((c) => c.field) : [];
    expect(fields).toEqual(expect.arrayContaining(['checklist.SCREEN', 'checklist.POWERS_ON', 'priority', 'estimate', 'issues', 'accessories', 'accessoriesOther']));
    const stale = await fd.agent.patch(`/api/tickets/${t.id}`).send({ version: t.version, priority: 'NORMAL' });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'STALE_RECORD', message: 'This ticket changed since you opened it.' });
    // technician may not change device/customer
    expect((await tech.agent.patch(`/api/tickets/${t.id}`).send({ version: res.version, deviceId: t.device.id })).status).toBe(403);
  });

  it('device/customer change (FD) writes device_changed/customer_changed and moves the open-ticket counters', async () => {
    const a = await checkInNew(fd.agent, { firstName: 'From' });
    const b = await checkInNew(fd.agent, { firstName: 'To' });
    const res = TicketDetail.parse(
      (await fd.agent.patch(`/api/tickets/${a.id}`).send({ version: a.version, customerId: b.customer.id, deviceId: b.device.id }).expect(200)).body,
    );
    expect(res.customer.id).toBe(b.customer.id);
    expect((await adminDb.customer.findUniqueOrThrow({ where: { id: a.customer.id } })).openTicketCount).toBe(0);
    expect((await adminDb.customer.findUniqueOrThrow({ where: { id: b.customer.id } })).openTicketCount).toBe(2);
    const tl = TimelineResponse.parse((await fd.agent.get(`/api/tickets/${a.id}/timeline`).expect(200)).body);
    expect(tl.items.map((i) => i.type)).toEqual(['created', 'customer_changed', 'device_changed']);
    const cc = tl.items[1]!;
    expect(cc.type === 'customer_changed' && cc.data).toMatchObject({ from: { displayName: 'From Lopez' }, to: { displayName: 'To Lopez' } });
  });

  it('assign / take / unassign; inactive assignee → 409; unchanged → no event', async () => {
    const t = await checkInNew(fd.agent);
    await tech.agent.post(`/api/tickets/${t.id}/assign`).send({ userId: tech.userId }).expect(200);
    await tech.agent.post(`/api/tickets/${t.id}/assign`).send({ userId: tech.userId }).expect(200);
    await fd.agent.post(`/api/tickets/${t.id}/assign`).send({ userId: null }).expect(200);
    const gone = await addMember(app, adminDb, owner.shopId, 'TECHNICIAN', 'Gone Tech');
    await adminDb.membership.update({ where: { id: gone.membershipId }, data: { status: 'DEACTIVATED' } });
    const res = await fd.agent.post(`/api/tickets/${t.id}/assign`).send({ userId: gone.userId });
    expect(res.body).toMatchObject({ code: 'ASSIGNEE_NOT_ACTIVE', message: "Gone Tech isn't an active member of this shop." });
    const tl = TimelineResponse.parse((await fd.agent.get(`/api/tickets/${t.id}/timeline`).expect(200)).body);
    const assigned = tl.items.filter((i) => i.type === 'assigned');
    expect(assigned.map((i) => i.type === 'assigned' && [i.data.from?.name ?? null, i.data.to?.name ?? null])).toEqual([
      [null, 'Tess Tech'],
      ['Tess Tech', null],
    ]);
    const assignees = AssigneesResponse.parse((await tech.agent.get('/api/assignees').expect(200)).body);
    expect(assignees.items[0]!.role).toBe('TECHNICIAN');
    expect(assignees.items.some((a) => a.name === 'Gone Tech')).toBe(false);
    expect(assignees.items.find((a) => a.userId === tech.userId)?.isSelf).toBe(true);
  });

  it('notes: author edits within 10 minutes; others 403; later 409; timeline filter + cursor', async () => {
    const t = await checkInNew(fd.agent);
    const note = TicketNote.parse((await tech.agent.post(`/api/tickets/${t.id}/notes`).send({ body: 'Opened it up' }).expect(201)).body);
    expect(note).toMatchObject({ visibility: 'INTERNAL', canEdit: true, author: { name: 'Tess Tech' } });
    const edited = TicketNote.parse((await tech.agent.patch(`/api/tickets/${t.id}/notes/${note.id}`).send({ body: 'Opened it up, swollen battery' }).expect(200)).body);
    expect(edited.editedAt).not.toBeNull();
    expect((await fd.agent.patch(`/api/tickets/${t.id}/notes/${note.id}`).send({ body: 'Mine now' })).status).toBe(403);
    await adminDb.ticketNote.update({ where: { id: note.id }, data: { createdAt: new Date(Date.now() - 11 * 60_000) } });
    expect((await tech.agent.patch(`/api/tickets/${t.id}/notes/${note.id}`).send({ body: 'late' })).body.code).toBe('NOTE_EDIT_WINDOW_PASSED');
    for (let i = 0; i < 5; i++) await fd.agent.post(`/api/tickets/${t.id}/notes`).send({ body: `n${i}`, visibility: 'CUSTOMER' }).expect(201);
    const notes = TimelineResponse.parse((await fd.agent.get(`/api/tickets/${t.id}/timeline?filter=notes`).expect(200)).body);
    expect(notes.items.every((i) => i.type === 'note_added')).toBe(true);
    expect(notes.items).toHaveLength(6);
    const all = TimelineResponse.parse((await fd.agent.get(`/api/tickets/${t.id}/timeline`).expect(200)).body);
    expect(all.items.some((i) => i.type === 'note_edited')).toBe(false); // hidden in "all"
    // cursor: newest 3, then older
    const p1 = TimelineResponse.parse((await fd.agent.get(`/api/tickets/${t.id}/timeline?limit=3`).expect(200)).body);
    const p2 = TimelineResponse.parse((await fd.agent.get(`/api/tickets/${t.id}/timeline?limit=3&cursor=${p1.olderCursor}`).expect(200)).body);
    const p3 = TimelineResponse.parse((await fd.agent.get(`/api/tickets/${t.id}/timeline?limit=3&cursor=${p2.olderCursor}`).expect(200)).body);
    expect([...p3.items, ...p2.items, ...p1.items].map((i) => i.id)).toEqual(all.items.map((i) => i.id));
    expect(p3.olderCursor).toBeNull();
  });
});

describe('due dates in the shop timezone with DST (DU1, A16)', () => {
  it('US: default due skips closed days and lands on closing time across the November DST change', async () => {
    const shop = await ownerWithShop(app, { shopName: 'NY Shop', country: 'US', timezone: 'America/New_York' });
    // Mon–Sat 10–19 (D9 defaults), Sunday closed. Turnaround 2 open days.
    const ctx = CheckInContext.parse((await shop.agent.get('/api/tickets/check-in-context').expect(200)).body);
    const expected = computeDefaultDueAt(new Date(ctx.serverNow), 2, ctx.hours, 'America/New_York');
    expect(ctx.defaultDue.dueAt).toBe(expected.dueAt);
    // An explicit date across DST: 2027-11-08 (Monday after fall-back) at closing 19:00 EST = 00:00Z next day.
    const t = await checkInNew(shop.agent, { extra: { dueDate: '2027-11-08' } });
    expect(t.dueAt).toBe('2027-11-09T00:00:00.000Z');
    // Before the change: 2027-11-05 (Friday) 19:00 EDT = 23:00Z.
    const t2 = await checkInNew(shop.agent, { extra: { dueDate: '2027-11-05', dueTime: '18:30' } });
    expect(t2).toMatchObject({ dueAt: '2027-11-05T22:30:00.000Z', dueHasTime: true });
    // Sunday (closed) date-only → 23:59 local.
    const t3 = await checkInNew(shop.agent, { extra: { dueDate: '2027-11-07' } });
    expect(t3.dueAt).toBe(zonedTimeToUtc('2027-11-07', '23:59', 'America/New_York').toISOString());
  });

  it('UK: spring-forward date keeps closing time (BST) and the turnaround setting is used', async () => {
    const shop = await ownerWithShop(app, { shopName: 'London Shop', country: 'GB', timezone: 'Europe/London' });
    await shop.agent.patch('/api/shop/ticket-settings').send({ defaultTurnaroundDays: 0 }).expect(200);
    const ctx = CheckInContext.parse((await shop.agent.get('/api/tickets/check-in-context').expect(200)).body);
    expect(ctx.defaultTurnaroundDays).toBe(0);
    const t = await checkInNew(shop.agent, { phone: '+447911123456', extra: { dueDate: '2027-03-29' } }); // Monday after BST starts
    expect(t.dueAt).toBe('2027-03-29T18:00:00.000Z'); // 19:00 BST
    const t2 = await checkInNew(shop.agent, { phone: '+447911123457', extra: { dueDate: '2027-03-26' } }); // Friday, GMT
    expect(t2.dueAt).toBe('2027-03-26T19:00:00.000Z');
  });
});
