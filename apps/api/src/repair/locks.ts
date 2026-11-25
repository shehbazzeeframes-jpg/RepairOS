/**
 * Row locks for Sprint 2 writes, in ONE order (documented in packages/db/README.md, "Lock order"):
 *
 *   1. shops row             lockShop (settings/staff/status config only; ticket config takes FOR NO KEY UPDATE)
 *   2. ticket_statuses       FOR SHARE when a ticket moves into (or closes from) a status, FOR UPDATE when the
 *                            status itself changes (category/name/hidden)
 *   3. customers             FOR UPDATE, sorted by id
 *   4. tickets               FOR NO KEY UPDATE (writes) or FOR SHARE (reads that must not race a write), sorted by id
 *   5. devices               FOR UPDATE, sorted by id
 *   6. shop_ticket_settings  the ticket number counter (check-in, last)
 *
 * A transaction may skip levels but never takes a lock of an earlier level after one of a later level. Ids are
 * read first without a lock when needed (e.g. a ticket's customer), the locks are taken top-down, and the row is
 * read again: if it changed in between, `TxRetryError` reruns the transaction (PrismaService.forShop).
 *
 * Every helper is its own statement, so under READ COMMITTED the next statement sees what the previous holder of the
 * lock committed.
 */
import type { ScopedTx } from '@repairos/db';

const sortedIds = (ids: Iterable<string | null | undefined>): string[] =>
  [...new Set([...ids].filter((x): x is string => typeof x === 'string' && x.length > 0))].sort();

/** Level 2. `share`: a ticket is about to reference the status; `update`: the status row itself changes. */
export async function lockStatuses(tx: ScopedTx, statusIds: Iterable<string | null | undefined>, mode: 'share' | 'update'): Promise<void> {
  const ids = sortedIds(statusIds);
  if (ids.length === 0) return;
  if (mode === 'update') {
    await tx.$queryRaw`
      SELECT "id" FROM "ticket_statuses" WHERE "id" = ANY(${ids}::text[]) AND "shopId" = app_current_shop_id()
      ORDER BY "id" COLLATE "C" FOR UPDATE`;
  } else {
    await tx.$queryRaw`
      SELECT "id" FROM "ticket_statuses" WHERE "id" = ANY(${ids}::text[]) AND "shopId" = app_current_shop_id()
      ORDER BY "id" COLLATE "C" FOR SHARE`;
  }
}

/** Level 3. */
export async function lockCustomers(tx: ScopedTx, customerIds: Iterable<string | null | undefined>): Promise<void> {
  const ids = sortedIds(customerIds);
  if (ids.length === 0) return;
  await tx.$queryRaw`
    SELECT "id" FROM "customers" WHERE "id" = ANY(${ids}::text[]) AND "shopId" = app_current_shop_id()
    ORDER BY "id" COLLATE "C" FOR UPDATE`;
}

/**
 * Level 4. `update` is FOR NO KEY UPDATE: it serialises ticket writes (and conflicts with FOR SHARE) but not with the
 * KEY SHARE that inserting a note/event/warranty ticket takes on the ticket through its foreign key.
 */
export async function lockTickets(tx: ScopedTx, ticketIds: Iterable<string | null | undefined>, mode: 'update' | 'share'): Promise<void> {
  const ids = sortedIds(ticketIds);
  if (ids.length === 0) return;
  if (mode === 'update') {
    await tx.$queryRaw`
      SELECT "id" FROM "tickets" WHERE "id" = ANY(${ids}::text[]) AND "shopId" = app_current_shop_id()
      ORDER BY "id" COLLATE "C" FOR NO KEY UPDATE`;
  } else {
    await tx.$queryRaw`
      SELECT "id" FROM "tickets" WHERE "id" = ANY(${ids}::text[]) AND "shopId" = app_current_shop_id()
      ORDER BY "id" COLLATE "C" FOR SHARE`;
  }
}

/**
 * Level 4 for a status re-categorisation (caller holds the status FOR UPDATE, so no ticket can enter it meanwhile):
 * every ticket in the status, sorted, before the FK cascade rewrites them (the cascade would lock them in scan order).
 */
export async function lockTicketsInStatus(tx: ScopedTx, statusId: string): Promise<void> {
  await tx.$queryRaw`
    SELECT "id" FROM "tickets" WHERE "statusId" = ${statusId} AND "shopId" = app_current_shop_id()
    ORDER BY "id" COLLATE "C" FOR NO KEY UPDATE`;
}

/** Level 5. */
export async function lockDevices(tx: ScopedTx, deviceIds: Iterable<string | null | undefined>): Promise<void> {
  const ids = sortedIds(deviceIds);
  if (ids.length === 0) return;
  await tx.$queryRaw`
    SELECT "id" FROM "devices" WHERE "id" = ANY(${ids}::text[]) AND "shopId" = app_current_shop_id()
    ORDER BY "id" COLLATE "C" FOR UPDATE`;
}
