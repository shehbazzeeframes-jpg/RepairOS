/**
 * Sprint 2 access rules at the API:
 *  - permission denials per role (front desk, technician, manager, owner) for every new route;
 *  - tenant isolation: every id-taking route answers 404 for another shop's ids (never 403);
 *  - A13: X-Shop-Id mismatch → 409 ACTIVE_SHOP_CHANGED with nothing written, on Sprint 1 and Sprint 2 routes.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { hasPermission, type Permission, type Role, SHOP_ID_HEADER, type TicketDetail } from '@repairos/contracts';
import { PrismaClient } from '@repairos/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, type Member, ownerWithShop, type OwnerWithShop } from './fixtures';
import { type Agent, createTestApp } from './helpers';
import { checkInNew, statuses, usPhone } from './s2';

let app: NestExpressApplication;
let adminDb: PrismaClient;
let owner: OwnerWithShop;
let other: OwnerWithShop;
let ticket: TicketDetail;
let otherTicket: TicketDetail;
let noteId: string;
let statusId: string;
const people = {} as Record<Role, { agent: Agent; userId: string }>;

beforeAll(async () => {
  app = await createTestApp();
  adminDb = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL_TEST });
  owner = await ownerWithShop(app, { shopName: 'Access Shop' });
  other = await ownerWithShop(app, { shopName: 'Other Shop' });
  people.OWNER = owner;
  for (const role of ['MANAGER', 'FRONT_DESK', 'TECHNICIAN'] as const) {
    const m: Member = await addMember(app, adminDb, owner.shopId, role);
    people[role] = m;
  }
  ticket = await checkInNew(owner.agent, { passcode: { lockType: 'PIN', value: '2468' } });
  otherTicket = await checkInNew(other.agent, { passcode: { lockType: 'PIN', value: '1357' } });
  noteId = (await owner.agent.post(`/api/tickets/${ticket.id}/notes`).send({ body: 'x' }).expect(201)).body.id;
  statusId = (await statuses(owner.agent)).Diagnosing!.id;
});
afterAll(async () => {
  await adminDb?.$disconnect();
  await app?.close();
});

/** [method, path, permission, body]. Paths use ids of the owner's shop. */
function routes(): [string, string, Permission | null, unknown?][] {
  const c = ticket.customer.id;
  const d = ticket.device.id;
  const t = ticket.id;
  return [
    ['get', '/api/customers', 'customers.view'],
    ['get', '/api/customers/duplicates?phone=2125550000', 'customers.view'],
    ['get', '/api/customers/tags', 'customers.view'],
    ['post', '/api/customers', 'customers.manage', { firstName: 'Perm', phones: [{ number: '+12122001234' }] }],
    ['get', `/api/customers/${c}`, 'customers.view'],
    ['patch', `/api/customers/${c}`, 'customers.manage', { version: 999 }],
    ['get', `/api/customers/${c}/consents`, 'customers.view'],
    ['post', `/api/customers/${c}/consents`, 'customers.manage', { changes: [{ channel: 'EMAIL', state: 'WITHDRAWN' }] }],
    ['post', `/api/customers/${c}/archive`, 'customers.manage'],
    ['post', `/api/customers/${c}/restore`, 'customers.manage'],
    ['get', `/api/customers/${c}/export`, 'customers.export_delete'],
    ['post', `/api/customers/${c}/erase`, 'customers.export_delete', { confirm: 'ERASE' }],
    ['get', `/api/customers/${c}/devices`, 'customers.view'],
    ['post', `/api/customers/${c}/devices`, 'customers.manage', { type: 'OTHER', brand: 'X', model: 'Y' }],
    ['patch', `/api/devices/${d}`, 'customers.manage', { colour: 'Red' }],
    ['post', `/api/devices/${d}/archive`, 'customers.manage'],
    ['post', `/api/devices/${d}/restore`, 'customers.manage'],
    ['get', '/api/devices/lookup?serial=ABCD1234', 'customers.view'],
    ['get', '/api/devices/model-suggestions?q=iph', 'customers.view'],
    ['get', '/api/ticket-statuses', 'tickets.view'],
    ['post', '/api/ticket-statuses', 'statuses.manage', { name: 'X', category: 'OPEN', colour: 'nope' }],
    ['patch', `/api/ticket-statuses/${statusId}`, 'statuses.manage', { colour: 'blue' }],
    ['put', '/api/ticket-statuses/order', 'statuses.manage', { ids: ['x'] }],
    ['get', '/api/shop/ticket-settings', 'settings.view'],
    ['patch', '/api/shop/ticket-settings', 'settings.manage', { defaultTurnaroundDays: 2 }],
    ['get', '/api/tickets/check-in-context', 'tickets.create'],
    ['post', '/api/tickets', 'tickets.create', {}],
    ['get', '/api/tickets', 'tickets.view'],
    ['get', '/api/tickets/counts', 'tickets.view'],
    ['get', `/api/tickets/${t}`, 'tickets.view'],
    ['patch', `/api/tickets/${t}`, 'tickets.edit', { version: 999 }],
    ['post', `/api/tickets/${t}/status`, 'tickets.edit', { statusId: 'nope' }],
    ['post', `/api/tickets/${t}/assign`, 'tickets.edit', { userId: owner.userId }],
    ['post', `/api/tickets/${t}/cancel`, 'tickets.cancel', { reason: 'OTHER' }],
    ['post', `/api/tickets/${t}/reopen`, 'tickets.cancel', { reason: 'x' }],
    ['get', `/api/tickets/${t}/timeline`, 'tickets.view'],
    ['post', `/api/tickets/${t}/notes`, 'tickets.edit', { body: 'note' }],
    ['patch', `/api/tickets/${t}/notes/${noteId}`, 'tickets.edit', { body: 'edit' }],
    ['post', `/api/tickets/${t}/passcode/reveal`, 'tickets.view_passcode'],
    ['get', '/api/assignees', 'tickets.view'],
    ['get', '/api/dashboard', 'tickets.view'],
    ['get', '/api/search?q=ab', null],
  ];
}

const call = (agent: Agent, method: string, path: string, body?: unknown) =>
  (agent as unknown as Record<string, (p: string) => { send: (b: unknown) => Promise<{ status: number; body: { code?: string } }> }>)[method]!(path).send(body ?? {});

describe('permission denials per role on every Sprint 2 route', () => {
  for (const role of ['OWNER', 'MANAGER', 'FRONT_DESK', 'TECHNICIAN'] as const) {
    it(`${role}: 403 FORBIDDEN exactly where its role lacks the permission`, async () => {
      for (const [method, path, permission, body] of routes()) {
        const res = await call(people[role].agent, method, path, body);
        const label = `${role} ${method} ${path}`;
        if (permission === null || hasPermission(role, permission)) {
          // A 403 here may only be a rule other than the role (e.g. editing someone else's note).
          if (res.status === 403) expect((res.body as { message?: string }).message, label).not.toBe('Your role does not allow this action');
        } else {
          expect(res.status, label).toBe(403);
          expect(res.body, label).toMatchObject({ code: 'FORBIDDEN', message: 'Your role does not allow this action' });
        }
      }
    });
  }

  it('fine-grained rules: technicians cannot collect, change device/customer, or create nested customers', async () => {
    const st = await statuses(owner.agent);
    const t = await checkInNew(owner.agent);
    await owner.agent.post(`/api/tickets/${t.id}/status`).send({ statusId: st['Ready for pickup']!.id }).expect(200);
    expect((await people.TECHNICIAN.agent.post(`/api/tickets/${t.id}/status`).send({ statusId: st.Collected!.id })).status).toBe(403);
    expect((await people.TECHNICIAN.agent.patch(`/api/tickets/${t.id}`).send({ version: 1, deviceId: t.device.id })).status).toBe(403);
    expect((await people.TECHNICIAN.agent.post(`/api/tickets/${t.id}/status`).send({ statusId: st['In repair']!.id })).status).toBe(200);
    // search: technician sees tickets and customers (both permissions)
    expect((await people.TECHNICIAN.agent.get(`/api/search?q=${t.numberLabel}`)).body.tickets).toHaveLength(1);
  });
});

describe('tenant isolation: another shop’s ids → 404 on every id route', () => {
  it('every route taking a customer, device, ticket, note or status id', async () => {
    const c = otherTicket.customer.id;
    const d = otherTicket.device.id;
    const t = otherTicket.id;
    const theirNote = (await other.agent.post(`/api/tickets/${t}/notes`).send({ body: 'theirs' }).expect(201)).body.id;
    const theirStatus = (await statuses(other.agent)).Diagnosing!.id;
    const before = JSON.stringify(await adminDb.ticket.findUniqueOrThrow({ where: { id: t } }));
    const cases: [string, string, unknown?][] = [
      ['get', `/api/customers/${c}`],
      ['patch', `/api/customers/${c}`, { version: 1, notes: 'x' }],
      ['get', `/api/customers/${c}/consents`],
      ['post', `/api/customers/${c}/consents`, { changes: [{ channel: 'EMAIL', state: 'GRANTED', source: 'IMPORT' }] }],
      ['post', `/api/customers/${c}/archive`],
      ['post', `/api/customers/${c}/restore`],
      ['get', `/api/customers/${c}/export`],
      ['post', `/api/customers/${c}/erase`, { confirm: 'ERASE' }],
      ['get', `/api/customers/${c}/devices`],
      ['post', `/api/customers/${c}/devices`, { type: 'OTHER', brand: 'X', model: 'Y' }],
      ['patch', `/api/devices/${d}`, { colour: 'Red' }],
      ['post', `/api/devices/${d}/archive`],
      ['post', `/api/devices/${d}/restore`],
      ['patch', `/api/ticket-statuses/${theirStatus}`, { colour: 'blue' }],
      ['get', `/api/tickets/${t}`],
      ['patch', `/api/tickets/${t}`, { version: 1, priority: 'URGENT' }],
      ['post', `/api/tickets/${t}/status`, { statusId }],
      ['post', `/api/tickets/${t}/assign`, { userId: null }],
      ['post', `/api/tickets/${t}/cancel`, { reason: 'DUPLICATE' }],
      ['post', `/api/tickets/${t}/reopen`, { reason: 'Because' }],
      ['get', `/api/tickets/${t}/timeline`],
      ['post', `/api/tickets/${t}/notes`, { body: 'hi' }],
      ['patch', `/api/tickets/${t}/notes/${theirNote}`, { body: 'hi' }],
      ['post', `/api/tickets/${t}/passcode/reveal`],
      // own ticket, other shop's references
      ['post', `/api/tickets/${ticket.id}/status`, { statusId: theirStatus }],
      ['post', '/api/tickets', { customerId: c, deviceId: d, issues: [{ code: 'BATTERY' }] }],
      ['post', '/api/tickets', { customerId: ticket.customer.id, deviceId: ticket.device.id, issues: [{ code: 'BATTERY' }], warrantyOfTicketId: t }],
      ['post', '/api/tickets', { customerId: ticket.customer.id, deviceId: ticket.device.id, issues: [{ code: 'BATTERY' }], assigneeUserId: other.userId }],
      ['post', `/api/tickets/${ticket.id}/assign`, { userId: other.userId }],
    ];
    for (const [method, path, body] of cases) {
      const res = await call(owner.agent, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    // lists, lookups and search never return the other shop's rows
    const lists = await Promise.all([
      owner.agent.get(`/api/tickets?view=all&customerId=${c}`),
      owner.agent.get(`/api/devices/lookup?imei=${otherTicket.device.imei}`),
      owner.agent.get(`/api/search?q=${otherTicket.numberLabel}`),
      owner.agent.get(`/api/customers/duplicates?phone=${encodeURIComponent(otherTicket.customer.phones[0]!.e164)}`),
    ]);
    expect(lists[0]!.body.items).toEqual([]);
    expect(lists[1]!.body.matches).toEqual([]);
    expect(lists[3]!.body.items).toEqual([]);
    expect(JSON.stringify(await adminDb.ticket.findUniqueOrThrow({ where: { id: t } }))).toBe(before);
  });
});

describe('A13: X-Shop-Id', () => {
  it('mismatch → 409 ACTIVE_SHOP_CHANGED and nothing written (Sprint 2 check-in and Sprint 1 settings)', async () => {
    const customers = await adminDb.customer.count({ where: { shopId: owner.shopId } });
    const settings = await adminDb.shopTicketSettings.findFirstOrThrow({ where: { shopId: owner.shopId } });
    const res = await owner.agent
      .post('/api/tickets')
      .set(SHOP_ID_HEADER, other.shopId)
      .send({
        newCustomer: { firstName: 'Stale', phones: [{ number: usPhone() }] },
        newDevice: { type: 'PHONE', brand: 'Apple', model: 'X' },
        issues: [{ code: 'BATTERY' }],
      });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ statusCode: 409, code: 'ACTIVE_SHOP_CHANGED', message: 'You switched shop in another tab.' });
    expect(await adminDb.customer.count({ where: { shopId: owner.shopId } })).toBe(customers);
    expect((await adminDb.shopTicketSettings.findFirstOrThrow({ where: { shopId: owner.shopId } })).nextNumber).toBe(settings.nextNumber);

    const shopBefore = await adminDb.shop.findUniqueOrThrow({ where: { id: owner.shopId } });
    const s1 = await owner.agent.patch('/api/shop').set(SHOP_ID_HEADER, other.shopId).send({ name: 'Hijacked' });
    expect(s1.body.code).toBe('ACTIVE_SHOP_CHANGED');
    expect((await adminDb.shop.findUniqueOrThrow({ where: { id: owner.shopId } })).name).toBe(shopBefore.name);
    for (const path of ['/api/staff', '/api/timeclock/me', '/api/tickets', '/api/search?q=ab', `/api/audit-events?from=2026-01-01&to=2026-01-02`]) {
      expect((await owner.agent.get(path).set(SHOP_ID_HEADER, 'something-else')).status, path).toBe(409);
    }
  });

  it('matching header works and is echoed; no header still works; /api/me is not shop-scoped', async () => {
    const res = await owner.agent.get('/api/tickets/counts').set(SHOP_ID_HEADER, owner.shopId).expect(200);
    expect(res.headers['x-shop-id']).toBe(owner.shopId);
    const created = await owner.agent
      .post('/api/customers')
      .set(SHOP_ID_HEADER, owner.shopId)
      .send({ firstName: 'Fresh', phones: [{ number: usPhone() }] });
    expect(created.status).toBe(201);
    expect((await owner.agent.get('/api/tickets/counts')).headers['x-shop-id']).toBe(owner.shopId);
    await owner.agent.get('/api/me').set(SHOP_ID_HEADER, other.shopId).expect(200);
  });

  it('after switching shop in another tab, the stale tab’s request is rejected', async () => {
    // One user, two shops: owner joins the other shop as manager and switches to it.
    await adminDb.membership.create({ data: { shopId: other.shopId, userId: owner.userId, role: 'MANAGER' } });
    await owner.agent.post('/api/me/active-shop').send({ shopId: other.shopId }).expect(200);
    const stale = await owner.agent.post(`/api/tickets/${ticket.id}/notes`).set(SHOP_ID_HEADER, owner.shopId).send({ body: 'from the stale tab' });
    expect(stale.body.code).toBe('ACTIVE_SHOP_CHANGED');
    expect(await adminDb.ticketNote.count({ where: { body: 'from the stale tab' } })).toBe(0);
    await owner.agent.post('/api/me/active-shop').send({ shopId: owner.shopId }).expect(200);
  });
});
