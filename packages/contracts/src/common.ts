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
