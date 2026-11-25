/**
 * Sprint 2 §1–§2 at the API: customers (create/validate/duplicates/tags/edit + STALE_RECORD/consents/list
 * search+filters/archive/restore/export/erase) and devices (create/IMEI/lookup/model suggestions/archive/edit).
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  ConsentHistoryResponse,
  CustomerDetail,
  CustomerExport,
  CustomerListResponse,
  CustomerTagsResponse,
  Device,
  DeviceListResponse,
  DeviceLookupResponse,
  DuplicateCheckResponse,
  EraseCustomerResponse,
  GlobalSearchResponse,
  ModelSuggestionsResponse,
  TicketDetail,
} from '@repairos/contracts';
import { PrismaClient } from '@repairos/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditOf, ownerWithShop, type OwnerWithShop } from './fixtures';
import { createTestApp } from './helpers';
import { checkInNew, imei, statuses, usPhone } from './s2';

let app: NestExpressApplication;
let adminDb: PrismaClient;
let owner: OwnerWithShop;

beforeAll(async () => {
  app = await createTestApp();
  adminDb = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL_TEST });
  owner = await ownerWithShop(app, { shopName: 'Customer Shop' });
});
afterAll(async () => {
  await adminDb?.$disconnect();
  await app?.close();
});

const create = async (body: object, agent = owner.agent) => CustomerDetail.parse((await agent.post('/api/customers').send(body).expect(201)).body);

describe('customers (CU1–CU5)', () => {
  it('creates with normalised phones, defaults and consents; validates the record rules', async () => {
    const c = await create({
      firstName: ' Ali ',
      lastName: 'Khan',
      email: 'ALI@Example.COM',
      phones: [{ number: '(212) 200-1111' }, { number: '+44 7911 123456', label: 'WORK', isWhatsapp: true }],
      tags: ['VIP', 'vip', 'School'],
      consents: [{ channel: 'SMS', state: 'GRANTED', source: 'IN_STORE_SIGNED' }],
    });
    expect(c).toMatchObject({
      displayName: 'Ali Khan',
      email: 'ali@example.com',
      primaryPhone: '+12122001111',
      preferredChannel: 'SMS',
      tags: ['VIP', 'School'],
      version: 1,
      consent: { SMS: { granted: true, source: 'IN_STORE_SIGNED', recordedByName: 'Olivia Owner' }, EMAIL: { granted: false } },
    });
    expect(c.whatsappPhoneId).toBe(c.phones[1]!.id);
    const bad = await owner.agent.post('/api/customers').send({ firstName: 'No contact' });
    expect(bad.status).toBe(400);
    expect(bad.body.issues[0].path).toEqual(['phones']);
    const badPhone = await owner.agent.post('/api/customers').send({ firstName: 'X', phones: [{ number: '12' }] });
    expect(badPhone.body.issues[0].path).toEqual(['phones', 0, 'number']);
    const pk = await ownerWithShop(app, { country: 'PK' });
    const pkc = await create({ firstName: 'Bilal', phones: [{ number: '0300-1234567' }] }, pk.agent);
    expect(pkc).toMatchObject({ primaryPhone: '+923001234567', preferredChannel: 'WHATSAPP' });
  });

  it('duplicate check: phone in any format or email, incl. archived, never erased, excludeId; up to 3 + more', async () => {
    const phone = usPhone();
    const a = await create({ firstName: 'Dup', lastName: 'One', phones: [{ number: phone }] });
    const b = await create({ firstName: 'Dup', lastName: 'Two', phones: [{ number: usPhone() }, { number: phone }], email: 'dup@x.com' });
    await owner.agent.post(`/api/customers/${b.id}/archive`).expect(200);
    for (let i = 0; i < 3; i++) await create({ firstName: `Dup${i}`, phones: [{ number: phone }] });
    const national = phone.replace('+1', '').replace(/(\d{3})(\d{3})(\d{4})/, '($1) $2-$3');
    const res = DuplicateCheckResponse.parse((await owner.agent.get(`/api/customers/duplicates?phone=${encodeURIComponent(national)}`).expect(200)).body);
    expect(res.items).toHaveLength(3);
    expect(res.more).toBe(2);
    const byEmail = DuplicateCheckResponse.parse((await owner.agent.get(`/api/customers/duplicates?email=DUP@x.com&excludeId=${a.id}`).expect(200)).body);
    expect(byEmail.items).toEqual([expect.objectContaining({ id: b.id, archived: true, matchedOn: ['email'] })]);
    const invalid = DuplicateCheckResponse.parse((await owner.agent.get('/api/customers/duplicates?phone=12').expect(200)).body);
    expect(invalid).toEqual({ items: [], more: 0 });
    expect((await owner.agent.get('/api/customers/duplicates')).status).toBe(400);
  });

  it('PATCH: version required, STALE_RECORD on mismatch, phone list replaced, merged record re-checked; consents appended once', async () => {
    const c = await create({ firstName: 'Edit', phones: [{ number: usPhone() }] });
    const updated = CustomerDetail.parse(
      (
        await owner.agent
          .patch(`/api/customers/${c.id}`)
          .send({
            version: c.version,
            lastName: 'Me',
            phones: [{ number: usPhone(), isPrimary: true }, { id: c.phones[0]!.id, number: c.phones[0]!.e164, label: 'LANDLINE' }],
            consents: [{ channel: 'EMAIL', state: 'GRANTED', source: 'ONLINE_FORM' }],
            email: 'edit@me.com',
          })
          .expect(200)
      ).body,
    );
    expect(updated).toMatchObject({ displayName: 'Edit Me', version: 2, consent: { EMAIL: { granted: true } } });
    expect(updated.phones[1]).toMatchObject({ id: c.phones[0]!.id, label: 'LANDLINE', isPrimary: false });
    const stale = await owner.agent.patch(`/api/customers/${c.id}`).send({ version: 1, notes: 'x' });
    expect(stale.body).toMatchObject({ code: 'STALE_RECORD', message: 'Someone else changed this customer. Reload to see their changes.' });
    const noContact = await owner.agent.patch(`/api/customers/${c.id}`).send({ version: 2, phones: [], email: null });
    expect(noContact.status).toBe(400);
    // consents: granting again is a no-op; withdrawing defaults the source
    await owner.agent.post(`/api/customers/${c.id}/consents`).send({ changes: [{ channel: 'EMAIL', state: 'GRANTED', source: 'IMPORT' }] }).expect(200);
    await owner.agent.post(`/api/customers/${c.id}/consents`).send({ changes: [{ channel: 'EMAIL', state: 'WITHDRAWN' }] }).expect(200);
    const hist = ConsentHistoryResponse.parse((await owner.agent.get(`/api/customers/${c.id}/consents`).expect(200)).body);
    expect(hist.items.map((e) => [e.channel, e.state, e.source])).toEqual([
      ['EMAIL', 'WITHDRAWN', 'CUSTOMER_REQUEST'],
      ['EMAIL', 'GRANTED', 'ONLINE_FORM'],
    ]);
    const granted = await owner.agent.post(`/api/customers/${c.id}/consents`).send({ changes: [{ channel: 'SMS', state: 'GRANTED' }] });
    expect(granted.status).toBe(400); // source required when granting
  });

  it('list: search name any order / accents / phone substring / email, filters, sorts, archived flag, tags', async () => {
    const shop = await ownerWithShop(app, { shopName: 'List Shop' });
    const mk = (b: object) => create(b, shop.agent);
    const jose = await mk({ firstName: 'José', lastName: 'Álvarez', phones: [{ number: '+12122004567' }], tags: ['VIP'], consents: [{ channel: 'SMS', state: 'GRANTED', source: 'IN_STORE_SIGNED' }] });
    const biz = await mk({ kind: 'BUSINESS', businessName: 'Acme School', businessContactName: 'Pat Jones', email: 'office@acme.edu', tags: ['school'] });
    const arch = await mk({ firstName: 'Old', lastName: 'Timer', phones: [{ number: usPhone() }] });
    await shop.agent.post(`/api/customers/${arch.id}/archive`).expect(200);
    const list = async (qs: string) => CustomerListResponse.parse((await shop.agent.get(`/api/customers?${qs}`).expect(200)).body);
    expect((await list('')).items.map((i) => i.displayName)).toEqual(['Acme School', 'José Álvarez']);
    expect((await list('archived=true')).items.map((i) => [i.displayName, i.archivedAt !== null])).toEqual([
      ['Acme School', false],
      ['José Álvarez', false],
      ['Old Timer', true],
    ]);
    expect((await list('q=alvarez%20jose')).items.map((i) => i.id)).toEqual([jose.id]);
    expect((await list('q=4567')).items.map((i) => i.id)).toEqual([jose.id]);
    expect((await list(`q=${encodeURIComponent('(212) 200-4567')}`)).items.map((i) => i.id)).toEqual([jose.id]);
    expect((await list('q=acme.edu')).items.map((i) => i.id)).toEqual([biz.id]);
    expect((await list('q=pat')).items.map((i) => i.id)).toEqual([biz.id]);
    expect((await list('q=timer')).items).toEqual([]);
    expect((await list('q=timer&archived=true')).items.map((i) => i.id)).toEqual([arch.id]);
    expect((await list('type=BUSINESS')).items.map((i) => i.id)).toEqual([biz.id]);
    expect((await list('tags=SCHOOL,nope')).items.map((i) => i.id)).toEqual([biz.id]);
    expect((await list('consent=SMS')).items.map((i) => i.id)).toEqual([jose.id]);
    expect((await list('sort=created')).items[0]!.id).toBe(biz.id);
    expect((await list('')).total).toBe(2);
    const tags = CustomerTagsResponse.parse((await shop.agent.get('/api/customers/tags?q=s').expect(200)).body);
    expect(tags.tags).toEqual(['school']);
    expect((await shop.agent.get('/api/customers?cursor=xx')).status).toBe(400);
    // R5: check-in search can include archived customers, flagged
    const s = GlobalSearchResponse.parse((await shop.agent.get('/api/search?q=timer&includeArchived=true').expect(200)).body);
    expect(s.customers.map((c) => [c.id, c.archivedAt !== null])).toEqual([[arch.id, true]]);
    expect(GlobalSearchResponse.parse((await shop.agent.get('/api/search?q=timer').expect(200)).body).customers).toEqual([]);
  });

  it('list pages with every sort (30 customers, limit 25)', async () => {
    const shop = await ownerWithShop(app, { shopName: 'Paging Customers' });
    for (let i = 0; i < 30; i++) await create({ firstName: `P${String(i).padStart(2, '0')}`, phones: [{ number: usPhone() }] }, shop.agent);
    for (const sort of ['name', 'last_visit', 'created']) {
      const p1 = CustomerListResponse.parse((await shop.agent.get(`/api/customers?sort=${sort}`).expect(200)).body);
      const p2 = CustomerListResponse.parse((await shop.agent.get(`/api/customers?sort=${sort}&cursor=${p1.nextCursor}`).expect(200)).body);
      expect(p1.total).toBe(30);
      expect(new Set([...p1.items, ...p2.items].map((i) => i.id)).size, sort).toBe(30);
      expect(p2.nextCursor).toBeNull();
    }
  });

  it('archive is blocked by open tickets; restore; both audited with archivedAt only', async () => {
    const t = await checkInNew(owner.agent, { firstName: 'Busy' });
    const blocked = await owner.agent.post(`/api/customers/${t.customer.id}/archive`);
    expect(blocked.body).toMatchObject({ code: 'CUSTOMER_HAS_OPEN_TICKETS', message: "Close or cancel this customer's 1 open tickets first." });
    await owner.agent.post(`/api/tickets/${t.id}/cancel`).send({ reason: 'DUPLICATE' }).expect(200);
    await owner.agent.post(`/api/customers/${t.customer.id}/archive`).expect(200);
    await owner.agent.post(`/api/customers/${t.customer.id}/archive`).expect(200); // no-op
    await owner.agent.post(`/api/customers/${t.customer.id}/restore`).expect(200);
    const archived = (await auditOf(adminDb, owner.shopId, 'customer.archived')).filter((a) => a.entityId === t.customer.id);
    expect(archived).toHaveLength(1);
    expect(Object.keys(archived[0]!.after as object)).toEqual(['archivedAt']);
    expect((await auditOf(adminDb, owner.shopId, 'customer.restored')).filter((a) => a.entityId === t.customer.id)).toHaveLength(1);
  });

  it('export: JSON download without passcodes or internal notes; audited with counts', async () => {
    const st = await statuses(owner.agent);
    const t = await checkInNew(owner.agent, { firstName: 'Export', passcode: { lockType: 'PIN', value: '987654' } });
    await owner.agent.post(`/api/tickets/${t.id}/notes`).send({ body: 'internal secret note' }).expect(201);
    await owner.agent.post(`/api/tickets/${t.id}/notes`).send({ body: 'Your phone is ready', visibility: 'CUSTOMER' }).expect(201);
    await owner.agent.post(`/api/tickets/${t.id}/status`).send({ statusId: st['Ready for pickup']!.id }).expect(200);
    const res = await owner.agent.get(`/api/customers/${t.customer.id}/export`).expect(200);
    expect(res.headers['content-disposition']).toMatch(new RegExp(`attachment; filename="customer-${t.customer.id}-\\d{4}-\\d{2}-\\d{2}\\.json"`));
    const body = CustomerExport.parse(res.body);
    expect(body.shop.name).toBe('Customer Shop');
    expect(body.devices[0]).toMatchObject({ passcodeOnFile: true, model: 'iPhone 13' });
    expect(body.tickets[0]!.customerVisibleNotes.map((n) => n.body)).toEqual(['Your phone is ready']);
    expect(body.tickets[0]!.statusHistory.map((s) => s.status)).toEqual(['Received', 'Ready for pickup']);
    expect(res.text).not.toContain('987654');
    expect(res.text).not.toContain('internal secret note');
    expect(res.text).not.toMatch(/passcodeCiphertext|passcodeIv|passcodeTag/);
    const audit = (await auditOf(adminDb, owner.shopId, 'customer.exported')).find((a) => a.entityId === t.customer.id)!;
    expect(audit.after).toEqual({ phones: 1, devices: 1, tickets: 1, consentEvents: 0 });
  });

  it('erase: confirm ERASE, blocked by open tickets, anonymises, keeps tickets as "Erased customer", 404 afterwards', async () => {
    const st = await statuses(owner.agent);
    const deviceImei = imei(777);
    const t = await checkInNew(owner.agent, { firstName: 'Erin', lastName: 'Erasable', email: 'erin@erase.me', imei: deviceImei, passcode: { lockType: 'PIN', value: '1357' } });
    const id = t.customer.id;
    expect((await owner.agent.post(`/api/customers/${id}/erase`).send({ confirm: 'erase' })).status).toBe(400);
    expect((await owner.agent.post(`/api/customers/${id}/erase`).send({ confirm: 'ERASE' })).body.code).toBe('CUSTOMER_HAS_OPEN_TICKETS');
    await owner.agent.post(`/api/tickets/${t.id}/notes`).send({ body: 'Repair record' }).expect(201);
    await owner.agent.post(`/api/tickets/${t.id}/status`).send({ statusId: st['Ready for pickup']!.id }).expect(200);
    await owner.agent.post(`/api/tickets/${t.id}/status`).send({ statusId: st.Collected!.id }).expect(200);
    const erased = EraseCustomerResponse.parse((await owner.agent.post(`/api/customers/${id}/erase`).send({ confirm: 'ERASE' }).expect(200)).body);
    expect(erased.counts).toMatchObject({ phones: 1, devices: 1, tickets: 1 });
    const row = await adminDb.customer.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ displayName: 'Erased customer', firstName: null, lastName: null, email: null, tags: [] });
    expect(await adminDb.customerPhone.count({ where: { customerId: id } })).toBe(0);
    const dev = await adminDb.device.findUniqueOrThrow({ where: { id: t.device.id } });
    expect(dev).toMatchObject({ imei: null, serial: null, colour: null, passcodeCiphertext: null, brand: 'Apple', model: 'iPhone 13' });
    for (const path of ['', '/export', '/consents', '/devices']) expect((await owner.agent.get(`/api/customers/${id}${path}`)).status, path).toBe(404);
    expect((await owner.agent.post(`/api/customers/${id}/restore`)).status).toBe(404);
    expect((await owner.agent.post(`/api/customers/${id}/erase`).send({ confirm: 'ERASE' })).status).toBe(404);
    const ticket = TicketDetail.parse((await owner.agent.get(`/api/tickets/${t.id}`).expect(200)).body);
    expect(ticket.customer).toMatchObject({ displayName: 'Erased customer', erased: true, phones: [], email: null });
    // reopen still allowed (closed within 7 days)
    await owner.agent.post(`/api/tickets/${t.id}/reopen`).send({ reason: 'Came back' }).expect(200);
    // no search hit by name / phone / IMEI; still found by ticket number
    const s = GlobalSearchResponse.parse((await owner.agent.get('/api/search?q=Erasable').expect(200)).body);
    expect(s.customers).toEqual([]);
    expect(s.tickets).toEqual([]);
    expect(GlobalSearchResponse.parse((await owner.agent.get(`/api/search?q=${deviceImei}`).expect(200)).body).devices).toEqual([]);
    const byNumber = GlobalSearchResponse.parse((await owner.agent.get(`/api/search?q=${t.numberLabel}`).expect(200)).body);
    expect(byNumber.tickets[0]).toMatchObject({ customerDisplayName: 'Erased customer' });
    // audit: counts only, no personal data anywhere in this customer's/device's audit rows
    const audit = (await auditOf(adminDb, owner.shopId, 'customer.erased')).find((a) => a.entityId === id)!;
    expect(Object.keys(audit.after as object).sort()).toEqual(['consentEvents', 'devices', 'notesKept', 'phones', 'tickets']);
    expect((audit.after as { notesKept: number }).notesKept).toBe(1);
    const allAudit = JSON.stringify(await auditOf(adminDb, owner.shopId));
    for (const pii of ['Erasable', 'erin@erase.me', deviceImei]) expect(allAudit).not.toContain(pii);
    const label = await owner.agent.get(`/api/audit-events?from=2020-01-01&to=2020-12-31`);
    expect(label.status).toBe(200);
  });
});

describe('devices (DV1–DV2)', () => {
  it('create/list/edit with IMEI rules; lookup warns about other customers; model suggestions; archive guard', async () => {
    const c = await create({ firstName: 'Dev', phones: [{ number: usPhone() }] });
    const badImei = await owner.agent.post(`/api/customers/${c.id}/devices`).send({ type: 'PHONE', brand: 'Apple', model: 'X', imei: '12345678901234' });
    expect(badImei.body.issues[0].message).toMatch(/IMEI has 15 digits/);
    const laptopImei = await owner.agent.post(`/api/customers/${c.id}/devices`).send({ type: 'LAPTOP', brand: 'Dell', model: 'XPS', imei: imei(5) });
    expect(laptopImei.status).toBe(400);
    const code = imei(9001);
    const d = Device.parse(
      (await owner.agent.post(`/api/customers/${c.id}/devices`).send({ type: 'PHONE', brand: 'Apple', model: 'iPhone 13', imei: `${code.slice(0, 5)} ${code.slice(5)}`, serial: 'ab-12 cd' }).expect(201)).body,
    );
    expect(d).toMatchObject({ imei: code, serial: 'AB12CD', lockType: 'NONE', passcodeOnFile: false, ticketCount: 0, openTicket: null });
    const other = await create({ firstName: 'Other', phones: [{ number: usPhone() }] });
    const look = DeviceLookupResponse.parse((await owner.agent.get(`/api/devices/lookup?imei=${code}&customerId=${other.id}`).expect(200)).body);
    expect(look.matches).toEqual([expect.objectContaining({ deviceId: d.id, customerDisplayName: 'Dev', sameCustomer: false })]);
    expect(DeviceLookupResponse.parse((await owner.agent.get(`/api/devices/lookup?serial=ab12cd&customerId=${c.id}`).expect(200)).body).matches[0]!.sameCustomer).toBe(true);
    expect((await owner.agent.get('/api/devices/lookup')).status).toBe(400);
    // edit: type → laptop requires clearing IMEI
    expect((await owner.agent.patch(`/api/devices/${d.id}`).send({ type: 'LAPTOP' })).status).toBe(400);
    const edited = Device.parse((await owner.agent.patch(`/api/devices/${d.id}`).send({ type: 'LAPTOP', imei: null, colour: 'Silver' }).expect(200)).body);
    expect(edited).toMatchObject({ type: 'LAPTOP', imei: null, colour: 'Silver' });
    // model suggestions (R1/R2): one box, shop history merged
    const sug = ModelSuggestionsResponse.parse((await owner.agent.get('/api/devices/model-suggestions?q=iph%2013').expect(200)).body);
    expect(sug.items[0]).toMatchObject({ type: 'PHONE', brand: 'Apple', model: 'iPhone 13' });
    expect(sug.items.findIndex((i) => i.model === 'iPhone 13')).toBeLessThan(sug.items.findIndex((i) => i.model === 'iPhone 13 mini'));
    const ps = ModelSuggestionsResponse.parse((await owner.agent.get('/api/devices/model-suggestions?type=PHONE&brand=apple&q=13').expect(200)).body);
    expect(ps.items[0]).toMatchObject({ model: 'iPhone 13', source: 'shop' });
    // archive guard + list
    const t = await checkInNew(owner.agent);
    expect((await owner.agent.post(`/api/devices/${t.device.id}/archive`)).body.code).toBe('DEVICE_HAS_OPEN_TICKETS');
    await owner.agent.post(`/api/devices/${d.id}/archive`).expect(200);
    expect(DeviceListResponse.parse((await owner.agent.get(`/api/customers/${c.id}/devices`).expect(200)).body).items).toEqual([]);
    expect(DeviceListResponse.parse((await owner.agent.get(`/api/customers/${c.id}/devices?archived=true`).expect(200)).body).items).toHaveLength(1);
    await owner.agent.post(`/api/devices/${d.id}/restore`).expect(200);
    const listed = DeviceListResponse.parse((await owner.agent.get(`/api/customers/${t.customer.id}/devices`).expect(200)).body);
    expect(listed.items[0]).toMatchObject({ ticketCount: 1, openTicket: { id: t.id, numberLabel: t.numberLabel } });
    // archived customer → 409 on new device
    await owner.agent.post(`/api/customers/${other.id}/archive`).expect(200);
    expect((await owner.agent.post(`/api/customers/${other.id}/devices`).send({ type: 'OTHER', brand: 'X', model: 'Y' })).body.code).toBe('CUSTOMER_ARCHIVED');
  });
});
