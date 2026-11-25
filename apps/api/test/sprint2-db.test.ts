/**
 * Sprint 2 data layer against the real (migrated) test database, as the app role with RLS:
 * default statuses/settings, gapless ticket numbers (A4), the denormalised status category, search (A14),
 * customer erasure (A11), passcode encryption at rest (A15) and the FIELD_ENCRYPTION_KEY startup check.
 */
import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DEFAULT_TICKET_STATUSES, normalizePhone } from '@repairos/contracts';
import {
  CLEARED_PASSCODE_COLUMNS,
  decryptField,
  encryptField,
  ERASED_CUSTOMER_DISPLAY_NAME,
  eraseCustomer,
  EraseCustomerError,
  nextTicketNumber,
  parseFieldKeyring,
  passcodeAad,
  passcodeColumns,
  passcodeFromRow,
  PrismaClient,
  searchCustomers,
  searchDevices,
  searchTickets,
  tenantDb,
} from '@repairos/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { ownerWithShop, type OwnerWithShop } from './fixtures';
import { createTestApp } from './helpers';
import { createCustomer, createRepair, createTicket } from './sprint2-fixtures';

let app: NestExpressApplication;
let adminDb: PrismaClient;
let appDb: PrismaClient;
let shop: OwnerWithShop;

beforeAll(async () => {
  app = await createTestApp();
  adminDb = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL_TEST });
  appDb = new PrismaClient({ datasourceUrl: process.env.APP_DATABASE_URL_TEST, log: [] });
  shop = await ownerWithShop(app, { shopName: 'Sprint 2 DB' });
});
afterAll(async () => {
  await appDb?.$disconnect();
  await adminDb?.$disconnect();
  await app?.close();
});

const db = () => tenantDb(appDb, { shopId: shop.shopId, userId: shop.userId });

describe('defaults for a new shop', () => {
  it('seeds exactly the contract DEFAULT_TICKET_STATUSES (order, category, role, colour, flags)', async () => {
    const rows = await db().client.ticketStatus.findMany({ orderBy: { position: 'asc' } });
    expect(
      rows.map((r) => ({
        name: r.name,
        category: r.category,
        systemRole: r.systemRole,
        colour: r.colour,
        notifyCustomer: r.notifyCustomer,
        requiresNote: r.requiresNote,
      })),
    ).toEqual(DEFAULT_TICKET_STATUSES);
    expect(rows.map((r) => r.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(rows.every((r) => !r.isHidden)).toBe(true);
  });

  it('seeds ticket settings: next number 1001, prefix T-, 2 days, delete passcode on close', async () => {
    const s = await db().client.shopTicketSettings.findFirstOrThrow();
    expect(s).toMatchObject({ nextNumber: 1001, numberPrefix: 'T-', defaultTurnaroundDays: 2, deletePasscodeOnClose: true });
  });

  it('app_ensure_ticket_defaults is idempotent', async () => {
    await db().tx((tx) => tx.$executeRaw`SELECT app_ensure_ticket_defaults(${shop.shopId})`);
    expect(await db().client.ticketStatus.count()).toBe(9);
    expect(await db().client.shopTicketSettings.count()).toBe(1);
  });
});

describe('gapless ticket numbers (A4)', () => {
  let other: OwnerWithShop;
  let ref: { customerId: string; deviceId: string };
  const dbOther = () => tenantDb(appDb, { shopId: other.shopId, userId: other.userId });

  beforeAll(async () => {
    other = await ownerWithShop(app, { shopName: 'Numbers' });
    ref = await dbOther().tx((tx) => createCustomer(tx, other.shopId, other.userId));
  });

  const numbersOf = async () =>
    (await adminDb.ticket.findMany({ where: { shopId: other.shopId }, orderBy: { number: 'asc' }, select: { number: true } })).map((t) => t.number);

  it('a rolled-back create does not consume a number', async () => {
    const first = await dbOther().tx((tx) => createTicket(tx, other.shopId, other.userId, ref));
    expect(first.ticketNumber).toBe(1001);
    await expect(
      dbOther().tx(async (tx) => {
        const n = await nextTicketNumber(tx, other.shopId);
        expect(n).toBe(1002);
        throw new Error('check-in failed after taking a number');
      }),
    ).rejects.toThrow(/check-in failed/);
    // A create that fails in the database (FK violation) rolls the counter back too.
    await expect(
      dbOther().tx((tx) => createTicket(tx, other.shopId, other.userId, { customerId: ref.customerId, deviceId: 'no-such-device' })),
    ).rejects.toThrow();
    const next = await dbOther().tx((tx) => createTicket(tx, other.shopId, other.userId, ref));
    expect(next.ticketNumber).toBe(1002);
    expect(await numbersOf()).toEqual([1001, 1002]);
  });

  it('20 parallel creates (with forced failures in between) give 20 consecutive unique numbers', async () => {
    const before = await numbersOf();
    const start = before[before.length - 1]! + 1;
    const ok = Array.from({ length: 20 }, () => dbOther().tx((tx) => createTicket(tx, other.shopId, other.userId, ref), { timeout: 20_000, maxWait: 20_000 }));
    const failing = Array.from({ length: 6 }, () =>
      dbOther().tx(
        async (tx) => {
          await nextTicketNumber(tx, other.shopId);
          throw new Error('forced failure');
        },
        { timeout: 20_000, maxWait: 20_000 },
      ),
    );
    const results = await Promise.allSettled([...ok, ...failing]);
    expect(results.slice(0, 20).every((r) => r.status === 'fulfilled')).toBe(true);
    expect(results.slice(20).every((r) => r.status === 'rejected')).toBe(true);
    const created = results.slice(0, 20).map((r) => (r as PromiseFulfilledResult<{ ticketNumber: number }>).value.ticketNumber);
    expect([...created].sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => start + i));
    expect(await numbersOf()).toEqual([...before, ...Array.from({ length: 20 }, (_, i) => start + i)]);
    const s = await adminDb.shopTicketSettings.findUniqueOrThrow({ where: { shopId: other.shopId } });
    expect(s.nextNumber).toBe(start + 20);
  });
});

describe('status category is denormalised safely', () => {
  it('changing a status category re-categorises its tickets (FK ON UPDATE CASCADE); a mismatch is rejected', async () => {
    const r = await createRepair(appDb, shop.shopId, shop.userId);
    const diag = r.statuses.Diagnosing!;
    await db().client.ticket.update({ where: { id: r.ticketId }, data: { statusId: diag.id, statusCategory: 'OPEN' } });
    await db().client.ticketStatus.update({ where: { id: diag.id }, data: { category: 'WAITING' } });
    expect((await db().client.ticket.findUniqueOrThrow({ where: { id: r.ticketId } })).statusCategory).toBe('WAITING');
    await expect(db().client.ticket.update({ where: { id: r.ticketId }, data: { statusCategory: 'READY' } })).rejects.toThrow(/foreign key/i);
    // An in-use status cannot become CLOSED (closedAt would be missing): backs the API's STATUS_IN_USE rule.
    await expect(db().client.ticketStatus.update({ where: { id: diag.id }, data: { category: 'CLOSED' } })).rejects.toThrow(/tickets_closed_at_check/);
    await db().client.ticketStatus.update({ where: { id: diag.id }, data: { category: 'OPEN' } });
  });

  it('CHECKs: IMEI/serial format, passcode all-or-nothing, status categories, prefix', async () => {
    const c = await db().tx((tx) => createCustomer(tx, shop.shopId, shop.userId));
    const bad = [
      { imei: '12345' },
      { serial: 'ab-12' },
      { passcodeCiphertext: new Uint8Array([1, 2, 3]) },
    ];
    for (const data of bad) {
      await expect(db().client.device.update({ where: { id: c.deviceId }, data })).rejects.toThrow(/check constraint/i);
    }
    await expect(db().client.shopTicketSettings.updateMany({ data: { numberPrefix: 'tt' } })).rejects.toThrow(/check constraint/i);
  });
});

describe('search (A14)', () => {
  let s: OwnerWithShop;
  const sdb = () => tenantDb(appDb, { shopId: s.shopId, userId: s.userId });
  const ids: Record<string, string> = {};
  const IMEI = '490154203237518';

  beforeAll(async () => {
    s = await ownerWithShop(app, { shopName: 'Search', country: 'PK' });
    await sdb().tx(async (tx) => {
      const ali = await createCustomer(tx, s.shopId, s.userId, { firstName: 'Ali', lastName: 'Khan', phone: '+923001234567', imei: IMEI });
      ids.ali = ali.customerId;
      ids.aliDevice = ali.deviceId;
      ids.aliTicket = (await createTicket(tx, s.shopId, s.userId, ali)).ticketId;
      ids.jose = (await createCustomer(tx, s.shopId, s.userId, { firstName: 'José', lastName: 'Peña', email: 'jose.pena@example.com', phone: '+442079460000' })).customerId;
      ids.biz = (await createCustomer(tx, s.shopId, s.userId, { businessName: 'Hafeez Centre Mobiles', phone: '+924235761234', serial: 'C02XK1ABCD' })).customerId;
      ids.archived = (await createCustomer(tx, s.shopId, s.userId, { firstName: 'Archie', lastName: 'Ved', phone: '+923211111111', archived: true })).customerId;
      ids.wild = (await createCustomer(tx, s.shopId, s.userId, { firstName: '100%_real', lastName: 'Name', phone: '+923331112222' })).customerId;
    });
  });

  const find = (q: string, opts: { e164?: string | null; includeArchived?: boolean } = {}) =>
    sdb().tx(async (tx) => (await searchCustomers(tx, { q, phoneE164: opts.e164 ?? normalizePhone(q, 'PK'), includeArchived: opts.includeArchived })).map((h) => h.id));

  it('names: contains, any word order, case- and accent-insensitive, business name', async () => {
    expect(await find('khan ali')).toEqual([ids.ali]);
    expect(await find('ALI KH')).toEqual([ids.ali]);
    expect(await find('jose pena')).toEqual([ids.jose]);
    expect(await find('PEÑA')).toEqual([ids.jose]);
    expect(await find('hafeez')).toEqual([ids.biz]);
    expect(await find('example.com')).toEqual([ids.jose]);
  });

  it('phones in any format: full numbers exact via E.164, 4+ digits as a substring', async () => {
    for (const q of ['0300-1234567', '03001234567', '+92 300 1234567', '923001234567', '1234567', '4567']) {
      expect(await find(q), q).toContain(ids.ali);
    }
    expect(await find('+44 20 7946 0000')).toEqual([ids.jose]);
    expect(await find('456')).toEqual([]); // < 4 digits
  });

  it('IMEI (full or last 4+) and serial match the owner; archived only on request; ranks the exact match first', async () => {
    expect(await find(IMEI)).toEqual([ids.ali]);
    expect(await find('7518')).toContain(ids.ali);
    expect(await find('c02xk1')).toEqual([ids.biz]);
    expect(await find('archie')).toEqual([]);
    expect(await find('archie', { includeArchived: true })).toEqual([ids.archived]);
  });

  it('treats LIKE wildcards and SQL as plain text', async () => {
    expect(await find('100%_real')).toEqual([ids.wild]);
    expect(await find('%%')).toEqual([]);
    expect(await find('__')).toEqual([]);
    expect(await find("'; DROP TABLE customers; --")).toEqual([]);
    expect(await adminDb.customer.count({ where: { shopId: s.shopId } })).toBe(5);
  });

  it('devices by IMEI/serial, exact match scored above partial', async () => {
    const hits = await sdb().tx((tx) => searchDevices(tx, IMEI));
    expect(hits).toEqual([{ id: ids.aliDevice, customerId: ids.ali, score: 2 }]);
    expect((await sdb().tx((tx) => searchDevices(tx, '3237518')))[0]!.score).toBe(1);
    expect(await sdb().tx((tx) => searchDevices(tx, '123'))).toEqual([]);
  });

  it('tickets by number, customer name/phone and IMEI', async () => {
    const t = await adminDb.ticket.findUniqueOrThrow({ where: { id: ids.aliTicket } });
    for (const [q, n] of [
      ['T-1001', t.number],
      ['ali khan', null],
      ['0300 1234567', null],
      [IMEI.slice(-6), null],
    ] as const) {
      const hits = await sdb().tx((tx) => searchTickets(tx, { shopId: s.shopId, q, ticketNumber: n, phoneE164: normalizePhone(q, 'PK') }));
      expect(hits.map((h) => h.id), q).toEqual([ids.aliTicket]);
    }
  });
});

describe('erase (A11 + tech lead clarification)', () => {
  let e: OwnerWithShop;
  const edb = () => tenantDb(appDb, { shopId: e.shopId, userId: e.userId });
  const PII = {
    firstName: 'Wilhelmina',
    lastName: 'Zamorakowski',
    email: 'wilhelmina.zamorakowski@example.org',
    phone: '+447911123456',
    phone2: '+447700900123',
    address: '42 Quayside Lofts',
    imei: '352099001761481',
    serial: 'ZQSERIAL4242',
    colour: 'Midnight Teal',
    notes: 'Knows the owner personally',
    tag: 'Zamorak VIP',
  };

  beforeAll(async () => {
    e = await ownerWithShop(app, { shopName: 'Erase', country: 'GB' });
  });

  /** Every text, varchar, json/jsonb and text[] column of every public table, as text. */
  async function findAnywhere(values: string[]): Promise<string[]> {
    const cols = await adminDb.$queryRaw<{ table: string; column: string }[]>`
      SELECT c.table_name AS "table", c.column_name AS "column"
      FROM information_schema.columns c JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = 'public' AND c.table_name <> '_prisma_migrations'
        AND (c.data_type IN ('text', 'character varying', 'json', 'jsonb') OR c.udt_name = '_text')`;
    const hits: string[] = [];
    for (const { table, column } of cols) {
      for (const v of values) {
        const rows = await adminDb.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM "${table}" WHERE strpos(lower("${column}"::text), lower($1)) > 0`,
          v,
        );
        if (rows[0]!.n > 0) hits.push(`${table}.${column} contains "${v}"`);
      }
    }
    return hits;
  }

  it('is blocked while a ticket is open, then removes every personal value from every table', async () => {
    const keyring = parseFieldKeyring(randomBytes(32).toString('base64'));
    const r = await createRepair(appDb, e.shopId, e.userId, {
      firstName: PII.firstName,
      lastName: PII.lastName,
      email: PII.email,
      phone: PII.phone,
      imei: PII.imei,
      serial: PII.serial,
      addressLine1: PII.address,
    });
    await edb().tx(async (tx) => {
      await tx.customer.update({
        where: { id: r.customerId },
        data: { notes: PII.notes, tags: [PII.tag], businessContactName: null, postcode: 'SW1A 1AA', marketingSmsAt: new Date() },
      });
      await tx.customerPhone.create({
        data: { shopId: e.shopId, customerId: r.customerId, e164: PII.phone2, digits: PII.phone2.slice(1), label: 'WORK', position: 1 },
      });
      await tx.device.update({
        where: { id: r.deviceId },
        data: { colour: PII.colour, notes: `Belongs to ${PII.firstName}`, lockType: 'PIN', ...passcodeColumns(encryptField(keyring, '0042', passcodeAad(e.shopId, r.deviceId))), passcodeSetAt: new Date() },
      });
    });
    // Audit rows that (against the rules) carry personal data: about the customer, the device, and an unrelated row.
    await adminDb.auditLog.createMany({
      data: [
        { shopId: e.shopId, action: 'customer.archived', entityType: 'Customer', entityId: r.customerId, before: { name: `${PII.firstName} ${PII.lastName}` }, after: { n: 1 } },
        { shopId: e.shopId, action: 'device.passcode_changed', entityType: 'Device', entityId: r.deviceId, after: { serial: PII.serial } },
        { shopId: e.shopId, action: 'ticket.cancelled', entityType: 'Ticket', entityId: r.ticketId, after: { reason: `called ${PII.phone}` } },
        { shopId: e.shopId, action: 'shop.updated', entityType: 'Shop', entityId: e.shopId, after: { name: 'Unrelated', phone: '+441632960000' } },
      ],
    });
    const values = [PII.firstName, PII.lastName, PII.email, PII.phone, PII.phone.slice(1), PII.phone2, PII.address, PII.imei, PII.serial, PII.colour, PII.notes, PII.tag];
    expect((await findAnywhere(values)).length).toBeGreaterThan(0);

    // Open ticket → refused, nothing changed.
    await expect(edb().tx((tx) => eraseCustomer(tx, r.customerId))).rejects.toEqual(new EraseCustomerError('CUSTOMER_HAS_OPEN_TICKETS', 1));
    await edb().client.ticket.update({
      where: { id: r.ticketId },
      data: { statusId: r.statuses.Collected!.id, statusCategory: 'CLOSED', closedAt: new Date() },
    });

    const counts = await edb().tx((tx) => eraseCustomer(tx, r.customerId));
    expect(counts).toEqual({ phones: 2, consentEvents: 1, devices: 1, tickets: 1, auditRowsRedacted: 3 });

    expect(await findAnywhere(values)).toEqual([]);

    const customer = await adminDb.customer.findUniqueOrThrow({ where: { id: r.customerId } });
    expect(customer).toMatchObject({
      displayName: ERASED_CUSTOMER_DISPLAY_NAME,
      firstName: null,
      lastName: null,
      email: null,
      addressLine1: null,
      postcode: null,
      notes: null,
      tags: [],
      preferredChannel: null,
      marketingSmsAt: null,
    });
    expect(customer.erasedAt).not.toBeNull();
    expect(customer.archivedAt).not.toBeNull();
    const [search] = await adminDb.$queryRaw<{ searchText: string }[]>`SELECT "searchText" FROM customers WHERE id = ${r.customerId}`;
    expect(search!.searchText.trim()).toBe('');
    const device = await adminDb.device.findUniqueOrThrow({ where: { id: r.deviceId } });
    expect(device).toMatchObject({ type: 'PHONE', brand: 'Apple', model: 'iPhone 13', imei: null, serial: null, colour: null, notes: null, lockType: 'NONE', ...CLEARED_PASSCODE_COLUMNS });
    // Kept: ticket (number, status), its note and timeline; the unrelated audit row.
    expect(await adminDb.ticket.findUniqueOrThrow({ where: { id: r.ticketId } })).toMatchObject({ customerId: r.customerId, number: r.ticketNumber });
    expect(await adminDb.ticketNote.count({ where: { ticketId: r.ticketId } })).toBe(1);
    expect(await adminDb.ticketEvent.count({ where: { ticketId: r.ticketId } })).toBe(2);
    expect((await adminDb.auditLog.findFirstOrThrow({ where: { shopId: e.shopId, action: 'shop.updated' } })).after).toEqual({ name: 'Unrelated', phone: '+441632960000' });

    // Not found by search any more (only by ticket number), and cannot be erased twice.
    await edb().tx(async (tx) => {
      for (const q of [PII.firstName, PII.phone, PII.imei.slice(-6)]) {
        expect(await searchCustomers(tx, { q, phoneE164: q.startsWith('+') ? q : null, includeArchived: true })).toEqual([]);
        expect(await searchTickets(tx, { shopId: e.shopId, q })).toEqual([]);
      }
      expect((await searchTickets(tx, { shopId: e.shopId, q: String(r.ticketNumber), ticketNumber: r.ticketNumber })).map((h) => h.id)).toEqual([r.ticketId]);
    });
    await expect(edb().tx((tx) => eraseCustomer(tx, r.customerId))).rejects.toEqual(new EraseCustomerError('CUSTOMER_ERASED'));
  });

  it('a lone first name does not redact unrelated audit rows (e.g. a staff member with that name)', async () => {
    const r = await createRepair(appDb, e.shopId, e.userId, { firstName: 'Khan', lastName: null, phone: '+447911000111' });
    await edb().client.ticket.update({ where: { id: r.ticketId }, data: { statusId: r.statuses.Cancelled!.id, statusCategory: 'CLOSED', closedAt: new Date() } });
    await adminDb.auditLog.create({
      data: { shopId: e.shopId, action: 'member.role_changed', entityType: 'Membership', entityId: 'm1', after: { name: 'Imran Khan' } },
    });
    await edb().tx((tx) => eraseCustomer(tx, r.customerId));
    expect((await adminDb.auditLog.findFirstOrThrow({ where: { shopId: e.shopId, entityId: 'm1' } })).after).toEqual({ name: 'Imran Khan' });
  });
});

describe('passcodes at rest (A15)', () => {
  it('the database never holds the plaintext; it decrypts only with the right key and AAD', async () => {
    const keyring = parseFieldKeyring(randomBytes(32).toString('base64'));
    const r = await createRepair(appDb, shop.shopId, shop.userId);
    const secret = '7319468250';
    await db().client.device.update({
      where: { id: r.deviceId },
      data: { lockType: 'PIN', ...passcodeColumns(encryptField(keyring, secret, passcodeAad(shop.shopId, r.deviceId))), passcodeSetAt: new Date() },
    });
    const [raw] = await adminDb.$queryRaw<{ dump: string }[]>`SELECT row_to_json(d)::text AS dump FROM devices d WHERE id = ${r.deviceId}`;
    expect(raw!.dump).not.toContain(secret);
    const [bytes] = await adminDb.$queryRaw<{ found: boolean }[]>`
      SELECT position(convert_to(${secret}, 'UTF8') in "passcodeCiphertext") > 0 AS found FROM devices WHERE id = ${r.deviceId}`;
    expect(bytes!.found).toBe(false);
    const row = await db().client.device.findUniqueOrThrow({ where: { id: r.deviceId } });
    expect(decryptField(keyring, passcodeFromRow(row)!, passcodeAad(shop.shopId, r.deviceId))).toBe(secret);
    expect(() => decryptField(keyring, passcodeFromRow(row)!, passcodeAad(shop.shopId, 'other-device'))).toThrow();
  });
});

describe('FIELD_ENCRYPTION_KEY startup check', () => {
  const base = { BETTER_AUTH_SECRET: 'x'.repeat(40), APP_DATABASE_URL: 'postgresql://repairos_app:pw@localhost/db', RESEND_API_KEY: 're_x', EMAIL_FROM: 'a@b.c' };
  const key = randomBytes(32).toString('base64');

  it('production refuses a missing, placeholder, short or malformed key', () => {
    for (const FIELD_ENCRYPTION_KEY of [undefined, '', 'change-me', randomBytes(16).toString('base64'), 'not base64!']) {
      expect(() => loadConfig({ ...base, NODE_ENV: 'production', FIELD_ENCRYPTION_KEY }), String(FIELD_ENCRYPTION_KEY)).toThrow(
        /Refusing to start: FIELD_ENCRYPTION_KEY/,
      );
    }
    expect(loadConfig({ ...base, NODE_ENV: 'production', FIELD_ENCRYPTION_KEY: key }).fieldEncryption?.currentVersion).toBe(1);
    expect(loadConfig({ ...base, NODE_ENV: 'production', FIELD_ENCRYPTION_KEY: `v2:${key},v1:${randomBytes(32).toString('base64')}` }).fieldEncryption?.currentVersion).toBe(2);
  });

  it('development/test tolerate an unset/placeholder key (null) but not a malformed one', () => {
    expect(loadConfig({ ...base, NODE_ENV: 'development', FIELD_ENCRYPTION_KEY: 'change-me' }).fieldEncryption).toBeNull();
    expect(loadConfig({ ...base, NODE_ENV: 'test' }).fieldEncryption).toBeNull();
    expect(() => loadConfig({ ...base, NODE_ENV: 'development', FIELD_ENCRYPTION_KEY: 'short' })).toThrow(/FIELD_ENCRYPTION_KEY/);
  });

  it('the parsed config never exposes the key material', () => {
    const cfg = loadConfig({ ...base, NODE_ENV: 'production', FIELD_ENCRYPTION_KEY: key });
    expect(JSON.stringify(cfg)).not.toContain(key);
  });
});

