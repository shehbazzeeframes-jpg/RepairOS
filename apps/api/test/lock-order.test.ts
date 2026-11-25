/**
 * Sprint 2 review-fix round 2: the lock order (packages/db/README.md "Lock order") and the transaction retry.
 *  - erase vs reopen no longer deadlock (customer → ticket in both);
 *  - a lock cycle that does happen is retried (40P01) and the request succeeds once, Idempotency-Key included;
 *  - a ticket moving into a status while the status is re-categorised gets the right 409 (or succeeds), never a 500.
 * Each race is made deterministic by holding locks in an owner-role transaction (./concurrency).
 */
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { TicketDetail } from '@repairos/contracts';
import { afterCommit, createPrismaClient, PrismaClient, tenantDb, TxRetryError } from '@repairos/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { whileLocked, whileLockedThen } from './concurrency';
import { ownerWithShop, type OwnerWithShop } from './fixtures';
import { createTestApp } from './helpers';
import { checkInExisting, checkInNew, newKey, statuses } from './s2';

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

let app: NestExpressApplication;
let adminDb: PrismaClient;
let owner: OwnerWithShop;
let st: Record<string, { id: string; category: string }>;
let warn: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  app = await createTestApp();
  adminDb = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL_TEST });
  owner = await ownerWithShop(app, { shopName: 'Lock Order Shop' });
  st = await statuses(owner.agent);
});
afterAll(async () => {
  await adminDb?.$disconnect();
  await app?.close();
});
afterEach(() => warn?.mockRestore());

/** Spies on Nest's Logger.warn; returns a getter for the "Transaction retry" lines logged since. */
function spyWarn() {
  warn = vi.spyOn(Logger.prototype, 'warn');
  return () => warn.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith('Transaction retry'));
}

const reopen = (id: string) => owner.agent.post(`/api/tickets/${id}/reopen`).send({ reason: 'Customer came back' });
const cancel = (id: string) => owner.agent.post(`/api/tickets/${id}/cancel`).send({ reason: 'DUPLICATE' }).expect(200);
const setShop = (tx: Tx) => tx.$executeRaw`SELECT set_config('app.shop_id', ${owner.shopId}, true)`;
const lockCustomer = (tx: Tx, id: string) => tx.$queryRaw`SELECT id FROM customers WHERE id = ${id} FOR UPDATE`;
const lockTicket = (tx: Tx, id: string) => tx.$queryRaw`SELECT id FROM tickets WHERE id = ${id} FOR UPDATE`;
const lockDevice = (tx: Tx, id: string) => tx.$queryRaw`SELECT id FROM devices WHERE id = ${id} FOR UPDATE`;

async function reopenEvents(ticketId: string) {
  const [events, audits] = await Promise.all([
    adminDb.ticketEvent.count({ where: { ticketId, type: 'reopened' } }),
    adminDb.auditLog.count({ where: { entityId: ticketId, action: 'ticket.reopened' } }),
  ]);
  return { events, audits };
}

describe('erase vs reopen (deadlock fixed by the lock order)', () => {
  it('a reopen that starts while an erase holds the customer waits for it, then gets 409 CUSTOMER_ERASED (no deadlock, no retry)', async () => {
    const retries = spyWarn();
    const t = await checkInNew(owner.agent, { firstName: 'Rhea', lastName: 'Opener' });
    await cancel(t.id);
    // The owner transaction runs exactly what app_erase_customer does, in two steps: it locks the customer (its first
    // statement), the reopen request starts and must wait, then the rest of the erase rewrites the customer's
    // tickets. Before the fix the reopen held the ticket and waited for the customer → lock cycle → 500.
    const res = await whileLockedThen(
      adminDb,
      async (tx) => {
        await setShop(tx);
        await lockCustomer(tx, t.customer.id);
      },
      () => reopen(t.id),
      (tx) => tx.$queryRaw`SELECT app_erase_customer(${t.customer.id})`,
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CUSTOMER_ERASED');
    expect(retries()).toEqual([]);
    const row = await adminDb.ticket.findUniqueOrThrow({ where: { id: t.id }, select: { statusCategory: true, reopenCount: true } });
    expect(row).toEqual({ statusCategory: 'CLOSED', reopenCount: 0 });
    const c = await adminDb.customer.findUniqueOrThrow({ where: { id: t.customer.id }, select: { erasedAt: true, openTicketCount: true } });
    expect(c.erasedAt).not.toBeNull();
    expect(c.openTicketCount).toBe(0);
  });

  it('an erase that starts while a reopen holds the customer waits for it, then gets 409 CUSTOMER_HAS_OPEN_TICKETS', async () => {
    const t = await checkInNew(owner.agent, { firstName: 'Ezra', lastName: 'Later' });
    await cancel(t.id);
    // Hold the customer as the reopen's first lock would; the API erase waits, then sees the reopened ticket.
    const res = await whileLocked(
      adminDb,
      async (tx) => {
        await lockCustomer(tx, t.customer.id);
        await tx.$executeRaw`UPDATE tickets SET "statusId" = ${st.Received!.id}, "statusCategory" = 'OPEN', "closedAt" = NULL,
                               "statusIdBeforeClose" = NULL, "cancelReason" = NULL WHERE id = ${t.id}`;
        await tx.$executeRaw`UPDATE customers SET "openTicketCount" = 1 WHERE id = ${t.customer.id}`;
      },
      () => owner.agent.post(`/api/customers/${t.customer.id}/erase`).send({ confirm: 'ERASE' }),
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CUSTOMER_HAS_OPEN_TICKETS');
    const c = await adminDb.customer.findUniqueOrThrow({ where: { id: t.customer.id }, select: { erasedAt: true } });
    expect(c.erasedAt).toBeNull();
  });

  it('reopen and erase of the same customer at the same time (repeated): one wins, the other gets its 409, never a 500', async () => {
    for (let i = 0; i < 8; i++) {
      const t = await checkInNew(owner.agent);
      await cancel(t.id);
      const [r, e] = await Promise.all([reopen(t.id), owner.agent.post(`/api/customers/${t.customer.id}/erase`).send({ confirm: 'ERASE' })]);
      const outcome = [r.status, e.status].join();
      expect(['200,409', '409,200']).toContain(outcome);
      if (r.status === 409) expect(r.body.code).toBe('CUSTOMER_ERASED');
      if (e.status === 409) expect(e.body.code).toBe('CUSTOMER_HAS_OPEN_TICKETS');
      const c = await adminDb.customer.findUniqueOrThrow({ where: { id: t.customer.id }, select: { openTicketCount: true } });
      expect(c.openTicketCount).toBe(r.status === 200 ? 1 : 0);
    }
  });
});

describe('ordinary contention needs no retry', () => {
  it('a double-submitted status change: one 200, one 409 TRANSITION_NOT_ALLOWED, no transaction retry', async () => {
    const retries = spyWarn();
    for (let i = 0; i < 5; i++) {
      const t = await checkInNew(owner.agent);
      const send = () => owner.agent.post(`/api/tickets/${t.id}/status`).send({ statusId: st.Diagnosing!.id });
      const [a, b] = await Promise.all([send(), send()]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect((a.status === 409 ? a : b).body.code).toBe('TRANSITION_NOT_ALLOWED');
    }
    expect(retries()).toEqual([]);
  });
});

describe('transaction retry (safety net)', () => {
  it('a lock cycle aborts the request with 40P01; it is retried once (logged at warn) and succeeds exactly once', async () => {
    const retries = spyWarn();
    const t = await checkInNew(owner.agent);
    await cancel(t.id);
    // Owner: ticket first, then the customer (the old, wrong order). The reopen takes customer → ticket and waits for
    // the ticket first, so its deadlock check fires first and Postgres aborts it.
    const res = await whileLockedThen(
      adminDb,
      (tx) => lockTicket(tx, t.id),
      () => reopen(t.id),
      (tx) => lockCustomer(tx, t.customer.id),
      { waitMs: 300, holdMs: 1500 },
    );
    expect(res.status).toBe(200);
    expect((res.body as TicketDetail).reopenCount).toBe(1);
    expect(retries()).toEqual([expect.stringMatching(/^Transaction retry 1\/2 after deadlock \(40P01\)/)]);
    expect(await reopenEvents(t.id)).toEqual({ events: 1, audits: 1 });
  });

  it('check-in with an Idempotency-Key that deadlocks: retried, one ticket, one number; a repeat returns it (created: false)', async () => {
    const retries = spyWarn();
    const first = await checkInNew(owner.agent);
    const key = newKey();
    const settingsBefore = await adminDb.shopTicketSettings.findUniqueOrThrow({ where: { shopId: owner.shopId }, select: { nextNumber: true } });
    // Owner holds the device; the check-in takes the customer, then waits for the device; the owner then asks for
    // the customer → cycle → the check-in (waiting first) is aborted and retried after the owner commits.
    const res = await whileLockedThen(
      adminDb,
      (tx) => lockDevice(tx, first.device.id),
      () =>
        owner.agent
          .post('/api/tickets')
          .set('Idempotency-Key', key)
          .send({ customerId: first.customer.id, deviceId: first.device.id, issues: [{ code: 'BATTERY' }] }),
      (tx) => lockCustomer(tx, first.customer.id),
      { waitMs: 300, holdMs: 1500 },
    );
    expect(res.status).toBe(201);
    expect(retries()).toEqual([expect.stringMatching(/after deadlock \(40P01\)/)]);
    const created = res.body as TicketDetail;
    expect(created.number).toBe(settingsBefore.nextNumber); // the aborted attempt's number rolled back

    const again = await owner.agent
      .post('/api/tickets')
      .set('Idempotency-Key', key)
      .send({ customerId: first.customer.id, deviceId: first.device.id, issues: [{ code: 'BATTERY' }] });
    expect(again.status).toBe(200);
    expect((again.body as TicketDetail).id).toBe(created.id);
    expect(await adminDb.ticketIdempotencyKey.count({ where: { key } })).toBe(1);
    expect(await adminDb.ticket.count({ where: { customerId: first.customer.id } })).toBe(2);
    const settingsAfter = await adminDb.shopTicketSettings.findUniqueOrThrow({ where: { shopId: owner.shopId }, select: { nextNumber: true } });
    expect(settingsAfter.nextNumber).toBe(settingsBefore.nextNumber + 1);
  });

  it('afterCommit side effects run once after the final commit, never for an attempt that was retried or rolled back', async () => {
    const prisma = createPrismaClient(process.env.APP_DATABASE_URL_TEST);
    try {
      const sent: string[] = [];
      const retried: number[] = [];
      const db = tenantDb(prisma, { shopId: owner.shopId }, { retry: { onRetry: (i) => retried.push(i.attempt), baseDelayMs: 1 } });
      let attempts = 0;
      const out = await db.tx(async (tx) => {
        attempts++;
        await afterCommit(() => void sent.push(`email ${attempts}`));
        await tx.shopTicketSettings.findFirst();
        if (attempts === 1) throw new TxRetryError('test');
        return 'done';
      });
      expect(out).toBe('done');
      expect(attempts).toBe(2);
      expect(retried).toEqual([1]);
      expect(sent).toEqual(['email 2']);

      await expect(
        db.tx(async () => {
          await afterCommit(() => void sent.push('never'));
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(sent).toEqual(['email 2']);
    } finally {
      await prisma.$disconnect();
    }
  });
});

describe('status re-categorised while a ticket moves into it → 409 or success, never 500', () => {
  async function newStatus(name: string, category: string): Promise<string> {
    const res = await owner.agent.post('/api/ticket-statuses').send({ name, category, colour: 'blue' }).expect(201);
    return (res.body as { id: string }).id;
  }
  const recategorise = (statusId: string, category: string) => (tx: Tx) =>
    tx.$executeRaw`UPDATE ticket_statuses SET category = ${category} WHERE id = ${statusId}`;

  it('moved to CLOSED meanwhile: the change waits for it and gets 409 TRANSITION_NOT_ALLOWED (was a 500 FK error)', async () => {
    const statusId = await newStatus('Bench 3', 'OPEN');
    const t = await checkInNew(owner.agent);
    const res = await whileLocked(adminDb, recategorise(statusId, 'CLOSED'), () =>
      owner.agent.post(`/api/tickets/${t.id}/status`).send({ statusId }),
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TRANSITION_NOT_ALLOWED');
    const row = await adminDb.ticket.findUniqueOrThrow({ where: { id: t.id }, select: { statusId: true, statusCategory: true } });
    expect(row).toEqual({ statusId: st.Received!.id, statusCategory: 'OPEN' });
  });

  it('moved to WAITING meanwhile: the change waits and succeeds with the new category', async () => {
    const statusId = await newStatus('Bench 4', 'OPEN');
    const t = await checkInNew(owner.agent);
    const res = await whileLocked(adminDb, recategorise(statusId, 'WAITING'), () =>
      owner.agent.post(`/api/tickets/${t.id}/status`).send({ statusId }),
    );
    expect(res.status).toBe(200);
    expect((res.body as TicketDetail).status).toMatchObject({ id: statusId, category: 'WAITING' });
    const row = await adminDb.ticket.findUniqueOrThrow({ where: { id: t.id }, select: { statusCategory: true } });
    expect(row.statusCategory).toBe('WAITING');
  });

  it('cancel into a closed status that is moved to OPEN meanwhile → 409 TRANSITION_NOT_ALLOWED', async () => {
    const statusId = await newStatus('Written off', 'CLOSED');
    const t = await checkInNew(owner.agent);
    const res = await whileLocked(adminDb, recategorise(statusId, 'OPEN'), () =>
      owner.agent.post(`/api/tickets/${t.id}/cancel`).send({ reason: 'DUPLICATE', statusId }),
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TRANSITION_NOT_ALLOWED');
  });

  it('re-categorising a status while a ticket move into it is uncommitted: waits, then re-categorises that ticket too', async () => {
    const statusId = await newStatus('Bench 5', 'OPEN');
    const t = await checkInNew(owner.agent);
    const res = await whileLocked(
      adminDb,
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM ticket_statuses WHERE id = ${statusId} FOR SHARE`;
        await tx.$executeRaw`UPDATE tickets SET "statusId" = ${statusId}, "statusCategory" = 'OPEN' WHERE id = ${t.id}`;
      },
      () => owner.agent.patch(`/api/ticket-statuses/${statusId}`).send({ category: 'WAITING' }),
    );
    expect(res.status).toBe(200);
    const row = await adminDb.ticket.findUniqueOrThrow({ where: { id: t.id }, select: { statusId: true, statusCategory: true } });
    expect(row).toEqual({ statusId, statusCategory: 'WAITING' });
  });

  it('status changes and re-categorisations at the same time (repeated): only 200/409, tickets always match their status', async () => {
    const statusId = await newStatus('Bench 6', 'OPEN');
    const customer = await checkInNew(owner.agent);
    const tickets = [customer, await checkInExisting(owner.agent, customer.customer.id, customer.device.id)];
    for (let i = 0; i < 10; i++) {
      const category = i % 2 === 0 ? 'WAITING' : 'OPEN';
      const results = await Promise.all([
        owner.agent.patch(`/api/ticket-statuses/${statusId}`).send({ category }),
        ...tickets.map((t, k) =>
          owner.agent.post(`/api/tickets/${t.id}/status`).send({ statusId: (i + k) % 2 === 0 ? statusId : st.Diagnosing!.id }),
        ),
      ]);
      for (const r of results) expect([200, 409]).toContain(r.status);
      const mismatched = await adminDb.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM tickets t JOIN ticket_statuses s ON s.id = t."statusId"
        WHERE t."shopId" = ${owner.shopId} AND t."statusCategory" <> s.category`;
      expect(mismatched[0]!.n).toBe(0);
    }
  });
});
