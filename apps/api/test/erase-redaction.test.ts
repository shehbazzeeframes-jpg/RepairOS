/**
 * Code review H2 / tech lead A11-b: erasure redacts the customer's identifiers from free text everywhere (ticket text
 * columns, issue labels, notes, timeline data, audit payloads), and audit payloads hold no free text at all.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { type TicketDetail } from '@repairos/contracts';
import { PrismaClient } from '@repairos/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditOf, ownerWithShop, type OwnerWithShop } from './fixtures';
import { createTestApp } from './helpers';
import { checkInNew, imei, statuses } from './s2';

let app: NestExpressApplication;
let adminDb: PrismaClient;
let owner: OwnerWithShop;
let st: Record<string, { id: string; category: string }>;

beforeAll(async () => {
  app = await createTestApp();
  adminDb = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL_TEST });
  owner = await ownerWithShop(app, { shopName: 'Erase Shop' });
  st = await statuses(owner.agent);
});
afterAll(async () => {
  await adminDb?.$disconnect();
  await app?.close();
});

/** Every row of every table in `public` as text (owner role: RLS does not apply). */
async function dumpAllRows(): Promise<{ table: string; row: string }[]> {
  const tables = await adminDb.$queryRaw<{ t: string }[]>`
    SELECT table_name AS t FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'`;
  const out: { table: string; row: string }[] = [];
  for (const { t } of tables) {
    const rows = await adminDb.$queryRawUnsafe<{ row: string }[]>(`SELECT x::text AS row FROM "${t}" x`);
    for (const r of rows) out.push({ table: t, row: r.row });
  }
  return out;
}

/** Rows that still hold one of `words` (case-insensitive) or, in their digits-only form, one of `digits`. */
function leaks(rows: { table: string; row: string }[], words: string[], digits: string[]) {
  const found: string[] = [];
  for (const { table, row } of rows) {
    const lower = row.toLowerCase();
    for (const w of words) if (lower.includes(w.toLowerCase())) found.push(`${table}: "${w}" in ${row.slice(0, 300)}`);
    const d = row.replace(/[^0-9]/g, '');
    for (const p of digits) if (d.includes(p)) found.push(`${table}: phone ${p} in ${row.slice(0, 300)}`);
  }
  return found;
}

const close = async (t: TicketDetail) => {
  await owner.agent.post(`/api/tickets/${t.id}/status`).send({ statusId: st['Ready for pickup']!.id }).expect(200);
  await owner.agent.post(`/api/tickets/${t.id}/status`).send({ statusId: st.Collected!.id }).expect(200);
};

describe('H2 / A11-b: erase redacts identifiers in free text', () => {
  it('reviewer scenario "Zelda Quixote": no name, email, address, postcode or phone (any format) survives anywhere', async () => {
    const created = await owner.agent
      .post('/api/tickets')
      .send({
        newCustomer: {
          firstName: 'Zelda',
          lastName: 'Quixote',
          email: 'zelda.quixote@example.com',
          phones: [{ number: '(212) 255-4321' }, { number: '212-256-9876' }],
          addressLine1: '742 Evergreen Terrace',
          addressLine2: 'Apt 9Q',
          city: 'Springfield',
          region: 'NY',
          postcode: '10027',
          notes: 'Zelda prefers texts',
        },
        newDevice: { type: 'PHONE', brand: 'Apple', model: 'iPhone 13', imei: imei(880_001), notes: 'Quixote engraved on back' },
        issues: [{ code: 'SCREEN_CRACKED' }, { label: 'Zelda says it reboots' }],
        description: 'Zelda Quixote dropped it. Call 212 255 4321 when done.',
        conditionNotes: "Quixote's case is cracked",
        accessories: ['OTHER'],
        accessoriesOther: "Zelda's charger",
      })
      .expect(201);
    const t = created.body as TicketDetail;

    const note = await owner.agent
      .post(`/api/tickets/${t.id}/notes`)
      .send({ body: 'Emailed zelda.quixote@example.com; she lives at 742 Evergreen Terrace, Apt 9Q, 10027.' })
      .expect(201);
    await owner.agent.patch(`/api/tickets/${t.id}/notes/${note.body.id}`).send({ body: 'Called ZELDA on +1 212-256-9876 (no answer).' }).expect(200);
    await owner.agent.post(`/api/tickets/${t.id}/notes`).send({ body: 'Hi Zelda, your phone is ready', visibility: 'CUSTOMER' }).expect(201);
    const edited = await owner.agent
      .patch(`/api/tickets/${t.id}`)
      .send({ version: t.version, description: 'Ms. quixote says screen flickers; alt number 2122569876.', conditionNotes: 'Zelda: scratches' })
      .expect(200);
    await owner.agent
      .post(`/api/tickets/${t.id}/cancel`)
      .send({ reason: 'OTHER', returnedConfirmed: true, note: 'Zelda took it back, call (212) 255-4321' })
      .expect(200);
    expect((edited.body as TicketDetail).version).toBeGreaterThan(t.version);

    // Another customer's ticket mentions her: the full name and phone are redacted there too, a lone first name is not.
    const other = await checkInNew(owner.agent, { firstName: 'Bob', lastName: 'Other' });
    await owner.agent.post(`/api/tickets/${other.id}/notes`).send({ body: 'Referred by Zelda Quixote (212) 255-4321. Zelda is a common name.' }).expect(201);

    await owner.agent.post(`/api/customers/${t.customer.id}/erase`).send({ confirm: 'ERASE' }).expect(200);

    const rows = await dumpAllRows();
    const words = ['Quixote', 'zelda.quixote@example.com', '742 Evergreen Terrace', 'Apt 9Q'];
    const phones = ['2122554321', '2122569876'];
    const relatedTicketRows = rows.filter((r) => r.row.includes(t.id));
    expect(relatedTicketRows.length).toBeGreaterThan(5);
    expect(leaks(rows, words, phones)).toEqual([]);
    // A 5-digit postcode could collide with numbers elsewhere in the test database: check this shop's rows only.
    expect(leaks(rows.filter((r) => r.row.includes(owner.shopId)), ['10027'], [])).toEqual([]);
    // "Zelda" (weak alone) is gone from her own records…
    expect(leaks(relatedTicketRows, ['Zelda'], [])).toEqual([]);
    // …and stays in the other customer's note, where only the full name and phone were redacted.
    const otherNote = await adminDb.ticketNote.findFirstOrThrow({ where: { ticketId: other.id } });
    expect(otherNote.body).toBe('Referred by [erased] [erased]. Zelda is a common name.');

    // Text around the identifiers is kept (repair record).
    const ticket = await adminDb.ticket.findUniqueOrThrow({ where: { id: t.id } });
    expect(ticket.description).toBe('Ms. [erased] says screen flickers; alt number [erased].');
    expect(ticket.cancelNote).toBe('[erased] took it back, call [erased]');
    expect(ticket.accessoriesOther).toBe("[erased]'s charger");
    const issues = await adminDb.ticketIssue.findMany({ where: { ticketId: t.id }, orderBy: { position: 'asc' } });
    expect(issues.map((i) => i.label)).toEqual(['Screen cracked', '[erased] says it reboots']);
  });

  it('audit payloads of cancel and reopen hold reason codes and ids only, no free text', async () => {
    const t = await checkInNew(owner.agent);
    await owner.agent.post(`/api/tickets/${t.id}/cancel`).send({ reason: 'OTHER', returnedConfirmed: true, note: 'Free text note 123' }).expect(200);
    await owner.agent.post(`/api/tickets/${t.id}/reopen`).send({ reason: 'Free text reason 456' }).expect(200);
    const cancelled = (await auditOf(adminDb, owner.shopId, 'ticket.cancelled')).find((a) => a.entityId === t.id)!;
    expect(cancelled.after).toEqual({ statusId: st.Cancelled!.id, reason: 'OTHER', returnedConfirmed: true });
    const reopened = (await auditOf(adminDb, owner.shopId, 'ticket.reopened')).find((a) => a.entityId === t.id)!;
    expect(reopened.before).toEqual({ statusId: st.Cancelled!.id });
    expect(reopened.after).toEqual({ statusId: st.Received!.id });
    expect(JSON.stringify(await auditOf(adminDb, owner.shopId))).not.toMatch(/Free text/);
  });

  it('short names: 2+ characters, whole words only; a 1-character name is never matched', async () => {
    const t = await checkInNew(owner.agent, { firstName: 'Al', lastName: 'Y' });
    await owner.agent.post(`/api/tickets/${t.id}/notes`).send({ body: 'Al also said Y is fine; call AL. Yes, all good.' }).expect(201);
    await close(t);
    await owner.agent.post(`/api/customers/${t.customer.id}/erase`).send({ confirm: 'ERASE' }).expect(200);
    const n = await adminDb.ticketNote.findFirstOrThrow({ where: { ticketId: t.id } });
    expect(n.body).toBe('[erased] also said Y is fine; call [erased]. Yes, all good.');
  });

  it('business customer: business name and contact name are redacted; a UK-style national number in text too', async () => {
    const res = await owner.agent
      .post('/api/tickets')
      .send({
        newCustomer: {
          kind: 'BUSINESS',
          businessName: 'Gizmo Fixers LLC',
          businessContactName: 'Priya Ramaswamy',
          phones: [{ number: '+447911123456' }],
        },
        newDevice: { type: 'LAPTOP', brand: 'Dell', model: 'XPS 13' },
        issues: [{ code: 'BATTERY' }],
        description: 'From Gizmo Fixers LLC, ask for Priya on 07911 123456 or +44 7911 123456.',
      })
      .expect(201);
    const t = res.body as TicketDetail;
    await close(t);
    await owner.agent.post(`/api/customers/${t.customer.id}/erase`).send({ confirm: 'ERASE' }).expect(200);
    const row = await adminDb.ticket.findUniqueOrThrow({ where: { id: t.id } });
    expect(row.description).toBe('From [erased], ask for [erased] on [erased] or [erased].');
  });
});
