import { z } from 'zod';
import { IsoDateTime } from './common';
import { CountryCode, CurrencyCode } from './markets';
import { BusinessHoursWeek } from './shops';

/**
 * Settings → Tickets and ticket numbering (Sprint 2 story §4, TK4, decision A4).
 * Numbers are gapless per shop: `UPDATE shop_counters SET nextValue = nextValue + 1 … RETURNING` inside the
 * creation transaction. The prefix is display-only (changing it re-labels every ticket; the number stays).
 */

export const DEFAULT_TURNAROUND_DAYS = 2;
export const MAX_TURNAROUND_DAYS = 30;
export const DEFAULT_TICKET_PREFIX = 'T-';
export const DEFAULT_FIRST_TICKET_NUMBER = 1001;
/** Largest ticket number (fits a Postgres int with room to spare). */
export const MAX_TICKET_NUMBER = 999_999_999;

export const TicketNumberPrefix = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z-]{0,5}$/, 'Use up to 5 letters A–Z or "-"');

/** `formatTicketNumber("T-", 1042)` → "T-1042"; empty prefix → "1042". */
export function formatTicketNumber(prefix: string, n: number): string {
  return `${prefix}${n}`;
}

/**
 * Parses a search query as a ticket number (TK4.2): "T-1042", "t1042", "#1042", "1042", " T 1042 " → 1042.
 * When `prefix` is given, any letters typed must equal the prefix's letters (case-insensitive, dashes/spaces ignored),
 * so "X-1042" is not a number in a "T-" shop. Null when the query isn't a ticket number.
 */
export function parseTicketNumberQuery(q: string, prefix?: string | null): number | null {
  const m = /^\s*#?\s*([A-Za-z][A-Za-z\s-]*?)?[\s-]*(\d{1,9})\s*$/.exec(q);
  if (!m) return null;
  const letters = (m[1] ?? '').replace(/[\s-]/g, '').toUpperCase();
  if (letters && prefix !== undefined && prefix !== null && letters !== prefix.replace(/[\s-]/g, '').toUpperCase()) return null;
  const n = Number(m[2]);
  return n >= 1 && n <= MAX_TICKET_NUMBER ? n : null;
}

/**
 * GET /api/shop/ticket-settings · permission `settings.view` → 200 `TicketSettings`.
 */
export const TicketSettings = z.object({
  /** 0–30 open days; 0 = same day. Default 2. */
  defaultTurnaroundDays: z.number().int().min(0).max(MAX_TURNAROUND_DAYS),
  /** 0–5 chars [A-Z-], default "T-". */
  numberPrefix: z.string(),
  /** The number the next ticket will get. */
  nextNumber: z.number().int().min(1),
  /** Highest number used so far; null when the shop has no tickets. `nextNumber` may only be set above it. */
  highestUsedNumber: z.number().int().nullable(),
  /** DV5: delete a device's passcode when its ticket closes (and it has no other non-closed ticket). Default true. */
  deletePasscodeOnClose: z.boolean(),
  updatedAt: IsoDateTime,
});
export type TicketSettings = z.infer<typeof TicketSettings>;

/**
 * PATCH /api/shop/ticket-settings · permission `settings.manage` → 200 `TicketSettings`.
 * Partial. `nextNumber` must be > `highestUsedNumber` (else 409 TICKET_NUMBER_TOO_LOW, `{highest}`) and may also be
 * lowered back down to highest+1. Audits `shop.ticket_settings_updated` (changed fields before/after).
 * Errors: 400 VALIDATION_FAILED, 409 TICKET_NUMBER_TOO_LOW.
 */
export const UpdateTicketSettingsInput = z
  .object({
    defaultTurnaroundDays: z.number().int().min(0).max(MAX_TURNAROUND_DAYS).optional(),
    numberPrefix: TicketNumberPrefix.optional(),
    nextNumber: z.number().int().min(1).max(MAX_TICKET_NUMBER).optional(),
    deletePasscodeOnClose: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Change at least one setting');
export type UpdateTicketSettingsInput = z.input<typeof UpdateTicketSettingsInput>;

export const TICKET_SETTINGS_PATH = '/api/shop/ticket-settings';

/** Pure version of the next-number rule. */
export function isValidNextNumber(next: number, highestUsed: number | null): boolean {
  return Number.isInteger(next) && next >= 1 && next <= MAX_TICKET_NUMBER && (highestUsed === null || next > highestUsed);
}

/**
 * GET /api/tickets/check-in-context · permission `tickets.create` → 200 `CheckInContext`.
 * Everything the check-in page needs without `settings.view` (front desk doesn't have it): the default due
 * (computed server-side with `computeDefaultDueAt`), hours + timezone so the page can recompute the due for a picked
 * date (`dueAtFor`), currency/tax display, prefix and country.
 */
export const CheckInContext = z.object({
  serverNow: IsoDateTime,
  country: CountryCode,
  currency: CurrencyCode,
  locale: z.string(),
  timezone: z.string(),
  /** Estimate label "incl. tax" when true, else "excl. tax". */
  pricesIncludeTax: z.boolean(),
  hours: BusinessHoursWeek,
  defaultTurnaroundDays: z.number().int(),
  numberPrefix: z.string(),
  defaultDue: z.object({ dueAt: IsoDateTime, date: z.string(), dueHasTime: z.literal(false) }),
});
export type CheckInContext = z.infer<typeof CheckInContext>;
