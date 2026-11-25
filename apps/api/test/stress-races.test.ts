/**
 * Stress test for the Sprint 2 lock order: 50 rounds of mixed concurrent writes on ONE customer with 3 tickets (two
 * share a device with a passcode): status changes, collect, cancel, reopen, ticket/customer/device edits, notes,
 * passcode reveals, re-categorising a status the tickets move into, and an erase attempt every round. No request
 * may fail with a 5xx, and after every round the denormalised counters must match the rows.
 */
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@repairos/db';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ownerWithShop, type OwnerWithShop } from './fixtures';
import { createTestApp } from './helpers';
import { checkInExisting, checkInNew, imei, statuses } from './s2';

let app: NestExpressApplication;
let adminDb: PrismaClient;
let owner: OwnerWithShop;
let st: Record<string, { id: string; category: string }>;
let bench: string;

beforeAll(async () => {
  app = await createTestApp();
  adminDb = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL_TEST });
  owner = await ownerWithShop(app, { shopName: 'Stress Shop' });
  st = await statuses(owner.agent);
  const res = await owner.agent.post('/api/ticket-statuses').send({ name: 'Bench', category: 'OPEN', colour: 'blue' }).expect(201);
  bench = (res.body as { id: string }).id;
});
afterAll(async () => {
  await adminDb?.$disconnect();
  await app?.close();
});

interface Fixture {
  customerId: string;
  sharedDevice: string;
  tickets: string[];
}

let seed = 900_000;
async function newFixture(): Promise<Fixture> {
  const t0 = await checkInNew(owner.agent, { firstName: 'Stella', lastName: 'Stress', passcode: { lockType: 'PIN', value: '8642' } });
  const d1 = await owner.agent
    .post(`/api/customers/${t0.customer.id}/devices`)
    .send({ type: 'PHONE', brand: 'Google', model: 'Pixel 8', imei: imei(seed++) })
    .expect(201);
  const t1 = await checkInExisting(owner.agent, t0.customer.id, (d1.body as { id: string }).id);
  const t2 = await checkInExisting(owner.agent, t0.customer.id, t0.device.id);
  return { customerId: t0.customer.id, sharedDevice: t0.device.id, tickets: [t0.id, t1.id, t2.id] };
}

/** Requests in one round, labelled for failure messages. */
type Op = [label: string, run: () => PromiseLike<Response>];

async function roundOps(f: Fixture, i: number): Promise<Op[]> {
  const ops: Op[] = [];
  const rows = await adminDb.ticket.findMany({ where: { id: { in: f.tickets } }, select: { id: true, statusCategory: true, version: true, priority: true } });
  for (const [k, id] of f.tickets.entries()) {
    const t = rows.find((r) => r.id === id)!;
    const status = (statusId: string) => () => owner.agent.post(`/api/tickets/${id}/status`).send({ statusId });
    if (t.statusCategory === 'CLOSED') {
      ops.push([`reopen ${k}`, () => owner.agent.post(`/api/tickets/${id}/reopen`).send({ reason: 'Back again' })]);
    } else if (t.statusCategory === 'READY') {
      ops.push((i + k) % 2 === 0 ? [`collect ${k}`, status(st.Collected!.id)] : [`diagnose ${k}`, status(st.Diagnosing!.id)]);
    } else {
      const choice = (i + k) % 4;
      if (choice === 0) ops.push([`bench ${k}`, status(bench)]);
      if (choice === 1) ops.push([`ready ${k}`, status(st['Ready for pickup']!.id)]);
      if (choice === 2) ops.push([`cancel ${k}`, () => owner.agent.post(`/api/tickets/${id}/cancel`).send({ reason: 'CUSTOMER_DECLINED', returnedConfirmed: true })]);
      if (choice === 3) {
        ops.push([
          `edit ${k}`,
          () => owner.agent.patch(`/api/tickets/${id}`).send({ version: t.version, priority: t.priority === 'NORMAL' ? 'URGENT' : 'NORMAL' }),
        ]);
      }
    }
  }
  const customer = await adminDb.customer.findUniqueOrThrow({ where: { id: f.customerId }, select: { version: true } });
  ops.push(
    ['recategorise bench', () => owner.agent.patch(`/api/ticket-statuses/${bench}`).send({ category: i % 2 === 0 ? 'WAITING' : 'OPEN' })],
    ['reveal', () => owner.agent.post(`/api/tickets/${f.tickets[0]}/passcode/reveal`).send({})],
    ['device edit', () => owner.agent.patch(`/api/devices/${f.sharedDevice}`).send({ notes: `Round ${i}` })],
    ['customer edit', () => owner.agent.patch(`/api/customers/${f.customerId}`).send({ version: customer.version, notes: `Round ${i}` })],
    ['note', () => owner.agent.post(`/api/tickets/${f.tickets[1]}/notes`).send({ body: `Round ${i}` })],
    ['erase', () => owner.agent.post(`/api/customers/${f.customerId}/erase`).send({ confirm: 'ERASE' })],
  );
  return ops;
}

async function assertConsistent(f: Fixture, round: number) {
  const [customer, tickets, deviceRow, settings] = await Promise.all([
    adminDb.customer.findUniqueOrThrow({ where: { id: f.customerId }, select: { openTicketCount: true, lastVisitAt: true, erasedAt: true } }),
    adminDb.ticket.findMany({
      where: { customerId: f.customerId },
      select: { id: true, statusCategory: true, reopenCount: true, createdAt: true, deviceId: true, status: { select: { category: true } } },
    }),
    adminDb.device.findUniqueOrThrow({ where: { id: f.sharedDevice }, select: { passcodeKeyVersion: true } }),
    adminDb.shopTicketSettings.findUniqueOrThrow({ where: { shopId: owner.shopId }, select: { deletePasscodeOnClose: true } }),
  ]);
  const ctx = `round ${round}`;
  expect(tickets, ctx).toHaveLength(3);
  const open = tickets.filter((t) => t.statusCategory !== 'CLOSED');
  expect(customer.openTicketCount, ctx).toBe(open.length);
  expect(customer.lastVisitAt?.getTime(), ctx).toBe(Math.max(...tickets.map((t) => t.createdAt.getTime())));
  if (customer.erasedAt) expect(open, ctx).toHaveLength(0);
  for (const t of tickets) {
    expect(t.statusCategory, ctx).toBe(t.status.category);
    const reopened = await adminDb.ticketEvent.count({ where: { ticketId: t.id, type: 'reopened' } });
    expect(t.reopenCount, `${ctx} reopenCount of ${t.id}`).toBe(reopened);
  }
  if (settings.deletePasscodeOnClose && !open.some((t) => t.deviceId === f.sharedDevice)) {
    expect(deviceRow.passcodeKeyVersion, `${ctx} passcode of a device with no open ticket`).toBeNull();
  }
}

describe('stress: mixed concurrent writes on one customer with 3 tickets', () => {
  it('50 rounds: no 5xx, counters consistent after every round', { timeout: 300_000 }, async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    try {
      let f = await newFixture();
      const tally: Record<string, number> = {};
      let erasures = 0;
      for (let i = 0; i < 50; i++) {
        if (i % 5 === 4) {
          // Every 5th round: close every ticket first, so the round races the erase against three reopens.
          const open = await adminDb.ticket.findMany({ where: { id: { in: f.tickets }, statusCategory: { not: 'CLOSED' } }, select: { id: true } });
          for (const t of open) {
            await owner.agent.post(`/api/tickets/${t.id}/cancel`).send({ reason: 'DUPLICATE', returnedConfirmed: true }).expect(200);
          }
        }
        const ops = await roundOps(f, i);
        const results = await Promise.all(ops.map(([, run]) => run()));
        const erased = results[ops.findIndex(([label]) => label === 'erase')]!.status === 200;
        results.forEach((res, n) => {
          const label = ops[n]![0];
          tally[res.status] = (tally[res.status] ?? 0) + 1;
          // 409: the domain answer of a lost race. Reveal only: 403 PASSCODE_NOT_AVAILABLE (ticket closed meanwhile),
          // 404 (passcode deleted on close), 429 (30 reveals per hour). An erased customer is 404 to the customer edit.
          const allowed =
            label === 'reveal' ? [200, 403, 404, 409, 429] : label === 'customer edit' && erased ? [200, 404, 409] : [200, 201, 409];
          expect(allowed, `round ${i} ${label}: ${res.status} ${JSON.stringify(res.body)}`).toContain(res.status);
        });
        await assertConsistent(f, i);
        if (erased) {
          erasures++;
          f = await newFixture();
        }
      }
      const retries = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith('Transaction retry'));
      console.info(`stress: responses ${JSON.stringify(tally)}, erasures ${erasures}, transaction retries ${retries.length}`);
      expect(tally['500'] ?? 0).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });
});
