import { z } from 'zod';
import { SearchText } from './common';
import { CustomerKind } from './customers';
import { DeviceType } from './devices';
import { StatusRef } from './ticket-statuses';

/**
 * Global search / command palette (Sprint 2 story §7 GS1).
 *
 * GET /api/search?q=&limit= · permission: signed in with an active shop; each group is filled only when the caller
 * has its permission (`tickets.view` → tickets; `customers.view` → customers and devices), else [] → 200
 * `GlobalSearchResponse`. p95 < 200 ms.
 * - Tickets (≤ limit): number (`parseTicketNumberQuery`), customer name/phone, IMEI/serial.
 * - Customers (≤ limit): name/phone/email; archived excluded; erased never match by name/phone.
 * - Devices (≤ limit): IMEI/serial; opens `latestTicket` or the customer.
 * - `exactMatch`: the query equals a ticket number, a full IMEI or a full serial → Enter jumps straight there
 *   (barcode-scanner friendly).
 * Errors: 400 VALIDATION_FAILED (q shorter than 2).
 * Web: `/` (not typing) or ⌘K/Ctrl+K opens; debounce 200 ms; Recent = last 10 opened tickets/customers per
 * user+shop in browser storage (`recentItemsKey`), cleared on sign-out; "See all ticket results" →
 * /tickets?view=all&q=….
 */
export const GlobalSearchQuery = z.object({
  q: SearchText,
  limit: z.coerce.number().int().min(1).max(10).default(5),
});
export type GlobalSearchQuery = z.infer<typeof GlobalSearchQuery>;

export const SearchTicketResult = z.object({
  id: z.string(),
  numberLabel: z.string(),
  customerDisplayName: z.string(),
  deviceLabel: z.string(),
  status: StatusRef,
});
export type SearchTicketResult = z.infer<typeof SearchTicketResult>;

export const SearchCustomerResult = z.object({
  id: z.string(),
  kind: CustomerKind,
  displayName: z.string(),
  primaryPhone: z.string().nullable(),
  email: z.string().nullable(),
});
export type SearchCustomerResult = z.infer<typeof SearchCustomerResult>;

export const SearchDeviceResult = z.object({
  id: z.string(),
  type: DeviceType,
  /** "Apple iPhone 13" */
  label: z.string(),
  imei: z.string().nullable(),
  serial: z.string().nullable(),
  customer: z.object({ id: z.string(), displayName: z.string() }),
  latestTicket: z.object({ id: z.string(), numberLabel: z.string() }).nullable(),
});
export type SearchDeviceResult = z.infer<typeof SearchDeviceResult>;

export const GlobalSearchResponse = z.object({
  tickets: z.array(SearchTicketResult),
  customers: z.array(SearchCustomerResult),
  devices: z.array(SearchDeviceResult),
  /** Where Enter jumps for an exact ticket number / full IMEI / full serial; null otherwise. */
  exactMatch: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('ticket'), ticketId: z.string() }),
      z.object({ kind: z.literal('device'), deviceId: z.string(), customerId: z.string(), ticketId: z.string().nullable() }),
    ])
    .nullable(),
});
export type GlobalSearchResponse = z.infer<typeof GlobalSearchResponse>;

export const GLOBAL_SEARCH_PATH = '/api/search';
export const GLOBAL_SEARCH_DEBOUNCE_MS = 200;
export const LIST_SEARCH_DEBOUNCE_MS = 250;
export const RECENT_ITEMS_MAX = 10;

/** Browser-storage key for Recent items (A19): per user + shop. */
export function recentItemsKey(userId: string, shopId: string): string {
  return `repairos:recent:${userId}:${shopId}`;
}

/** A Recent entry kept in browser storage (entries that now 404 are dropped). */
export const RecentItem = z.object({
  kind: z.enum(['ticket', 'customer']),
  id: z.string(),
  label: z.string(),
  openedAt: z.string(),
});
export type RecentItem = z.infer<typeof RecentItem>;
