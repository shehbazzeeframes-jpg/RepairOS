import { z } from 'zod';

/** ISO 8601 UTC timestamp as sent over the wire, e.g. "2026-11-25T09:30:00.000Z". */
export const IsoDateTime = z.string().datetime();

/** A shop-local calendar date "YYYY-MM-DD" (interpreted in the shop's timezone by the API). */
export const LocalDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'Enter a real date');
export type LocalDate = z.infer<typeof LocalDate>;

/** Inclusive number of calendar days from `from` to `to` (both "YYYY-MM-DD"); 1 when equal. */
export function daysInRange(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

/** Email as the story defines it: trimmed, lower-cased, ≤ 254 chars, same check as sign-up. */
export const EmailAddress = z
  .string()
  .trim()
  .min(1, 'Enter an email address')
  .max(254, 'Use 254 characters or fewer')
  .email('Enter a valid email address')
  .transform((s) => s.toLowerCase());

/** Required reason for timesheet corrections/deletes: trimmed, 3–200 chars. */
export const Reason = z.string().trim().min(3, 'Use at least 3 characters').max(200, 'Use 200 characters or fewer');

/** Route param ids (cuid / cuid2). */
export const IdParam = z.string().min(1).max(64);

/** Query-string boolean: "true"/"1" → true, "false"/"0"/absent → false. */
export const QueryBoolean = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .optional()
  .transform((v) => v === true || v === 'true' || v === '1');

// ---------- Sprint 2: shared list/query helpers ----------

/** Page sizes offered by list screens (customers, tickets): 25 (default) / 50 / 100. */
export const PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;

/** `limit` query param restricted to `PAGE_SIZES`, default 25. */
export const PageSizeQuery = z.coerce
  .number()
  .int()
  .default(DEFAULT_PAGE_SIZE)
  .refine((n) => (PAGE_SIZES as readonly number[]).includes(n), 'Use 25, 50 or 100');

/** Opaque keyset cursor from a previous page's `nextCursor`. A malformed cursor → 400 VALIDATION_FAILED. */
export const CursorQuery = z.string().min(1).max(500).optional();

/** `total` above this is reported as `{ total: 10000, totalCapped: true }` and shown as "10,000+" (story §9). */
export const LIST_TOTAL_CAP = 10_000;

/**
 * Multi-value query param. Accepts repeated params (`?a=x&a=y`, which the API parses as an array) or one
 * comma-separated value (`?a=x,y`). Empty → undefined. Each part is validated with `item`; duplicates are dropped.
 */
export function queryList<T extends z.ZodTypeAny>(item: T, max = 50) {
  return z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v, ctx): z.output<T>[] | undefined => {
      if (v === undefined) return undefined;
      const parts = (Array.isArray(v) ? v : [v])
        .flatMap((s) => s.split(','))
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length === 0) return undefined;
      const parsed = z.array(item).max(max).safeParse(parts);
      if (!parsed.success) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: parsed.error.issues[0]?.message ?? 'Invalid value' });
        return z.NEVER;
      }
      return [...new Set(parsed.data as z.output<T>[])];
    });
}

/** Optional query-string boolean: absent → undefined (filter not applied), "true"/"1" → true, "false"/"0" → false. */
export const OptionalQueryBoolean = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === true || v === 'true' || v === '1'));

/** A shop member as shown in lists and timelines. `active: false` = deactivated ("Sam (deactivated)"). */
export const UserRef = z.object({ userId: z.string(), name: z.string(), active: z.boolean() });
export type UserRef = z.infer<typeof UserRef>;

/** Optimistic-concurrency version echoed back on edits; mismatch → 409 STALE_RECORD. */
export const RecordVersion = z.number().int().min(0);

/** Search box text: trimmed, 2–100 chars. */
export const SearchText = z.string().trim().min(2, 'Type at least 2 characters').max(100);
