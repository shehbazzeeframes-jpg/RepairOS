/**
 * Search SQL (A14, story §9). Every value is a bound parameter (Prisma.sql): user input is never concatenated
 * into SQL, and LIKE wildcards in it are escaped by the database functions (app_like_escape).
 *
 * Fuzzy matching (trigram `LIKE '%x%'`) runs in the SECURITY DEFINER functions app_search_customers and
 * app_search_devices: LIKE is not LEAKPROOF, so under RLS Postgres would refuse to use the trigram indexes for it
 * and scan the whole shop instead. The functions filter by app_current_shop_id() themselves, so these helpers must
 * run inside `tenantDb(...).tx(...)` (or a transaction that SET LOCAL app.shop_id). See PERF.md for plans/timings.
 *
 * The *Sql builders return a subquery `SELECT "id", "score"` for composing into list queries, e.g.
 *
 *   const hits = customerSearchSql({ q, phoneE164 });
 *   tx.$queryRaw`SELECT c.* FROM "customers" c JOIN (${hits}) h ON h."id" = c."id"
 *                WHERE c."shopId" = ${shopId} ... ORDER BY h."score" DESC, c."displayName", c."id" LIMIT ${limit}`;
 *
 * or (small result sets) `where: { id: { in: ids } }` through the scoped client.
 */
import { Prisma } from '@prisma/client';
import type { RawSqlTx } from './tickets';

export interface SearchHit {
  id: string;
  score: number;
}

export interface CustomerSearchOptions {
  /** What the user typed (names, email, phone digits, IMEI/serial). */
  q: string;
  /** `q` normalised with contracts `normalizePhone(q, shop.country)` when it is a valid phone number. */
  phoneE164?: string | null;
  /** Include archived customers (list "Show archived", duplicate checks). Erased customers never match. */
  includeArchived?: boolean;
  /** Also match customers through their devices' IMEI/serial (4+ chars). Default true. */
  matchDevices?: boolean;
  /** null/undefined = all matches. */
  limit?: number | null;
}

/** Customers of the current shop matching `q`: name/business/contact/email words (any order), phone, IMEI/serial. */
export function customerSearchSql(o: CustomerSearchOptions): Prisma.Sql {
  return Prisma.sql`SELECT "id", "score" FROM app_search_customers(${o.q}::text, ${o.phoneE164 ?? null}::text, ${
    o.includeArchived ?? false
  }::boolean, ${o.limit ?? null}::integer, ${o.matchDevices ?? true}::boolean)`;
}

export async function searchCustomers(tx: RawSqlTx, o: CustomerSearchOptions): Promise<SearchHit[]> {
  return tx.$queryRaw<SearchHit[]>(customerSearchSql(o));
}

export interface DeviceSearchHit extends SearchHit {
  customerId: string;
}

/** Devices of the current shop whose IMEI/serial equals (score 2) or contains (score 1; 4+ chars) `q`. */
export function deviceSearchSql(q: string, limit?: number | null): Prisma.Sql {
  return Prisma.sql`SELECT "id", "customerId", "score" FROM app_search_devices(${q}::text, ${limit ?? null}::integer)`;
}

export async function searchDevices(tx: RawSqlTx, q: string, limit?: number | null): Promise<DeviceSearchHit[]> {
  return tx.$queryRaw<DeviceSearchHit[]>(deviceSearchSql(q, limit));
}

export interface TicketSearchOptions {
  shopId: string;
  q: string;
  /** contracts `parseTicketNumberQuery(q, prefix)`: exact ticket number (T-1042, t1042, 1042). */
  ticketNumber?: number | null;
  phoneE164?: string | null;
}

/**
 * Tickets of the shop matching `q` (§5.2.5, §7): exact number (score 10), IMEI/serial of the ticket's device
 * (score 2-3), or the customer's name/phone/email (customer score; archived customers included, erased never).
 * Returns `SELECT "id", "score"` (one row per ticket).
 */
export function ticketSearchSql(o: TicketSearchOptions): Prisma.Sql {
  const byNumber =
    o.ticketNumber != null
      ? Prisma.sql`SELECT t."id", 10::real AS "score" FROM "tickets" t
                   WHERE t."shopId" = ${o.shopId} AND t."number" = ${o.ticketNumber}::integer
                   UNION ALL `
      : Prisma.empty;
  return Prisma.sql`SELECT s."id", max(s."score")::real AS "score" FROM (
    ${byNumber}
    SELECT t."id", h."score" FROM (${customerSearchSql({ q: o.q, phoneE164: o.phoneE164, includeArchived: true, matchDevices: false })}) h
      JOIN "tickets" t ON t."shopId" = ${o.shopId} AND t."customerId" = h."id"
    UNION ALL
    SELECT t."id", (d."score" + 1)::real FROM (${deviceSearchSql(o.q)}) d
      JOIN "tickets" t ON t."shopId" = ${o.shopId} AND t."deviceId" = d."id"
  ) s GROUP BY s."id"`;
}

/** Best matches first, then newest ticket. */
export async function searchTickets(tx: RawSqlTx, o: TicketSearchOptions & { limit?: number }): Promise<SearchHit[]> {
  return tx.$queryRaw<SearchHit[]>`
    SELECT h."id", h."score" FROM (${ticketSearchSql(o)}) h
    JOIN "tickets" t ON t."id" = h."id" AND t."shopId" = ${o.shopId}
    ORDER BY h."score" DESC, t."createdAt" DESC, t."id"
    LIMIT ${o.limit ?? 50}::integer`;
}
