import { z } from 'zod';
import { IsoDateTime, LocalDate, Reason, daysInRange } from './common';
import { Role } from './roles';
import { StaffStatus } from './staff';

/**
 * Clock in/out and timesheets (Sprint 1 story §5, D5, D8).
 * All instants are UTC ISO strings; "days" are shop-local dates "YYYY-MM-DD" in the shop's timezone.
 * An entry belongs to the shop-local day it STARTED on (overnight entries are not split).
 * Durations come from UTC instants (DST-correct).
 */

/** Entries longer than this are flagged "Long shift"; an open entry older than this shows the top-bar warning. */
export const LONG_SHIFT_MINUTES = 14 * 60;
/** A single entry may not exceed this. */
export const MAX_ENTRY_MINUTES = 24 * 60;
/** Max inclusive day range for timesheet queries and export. */
export const MAX_TIMESHEET_RANGE_DAYS = 93;

export const TimeEntrySource = z.enum(['SELF', 'MANUAL']);
export type TimeEntrySource = z.infer<typeof TimeEntrySource>;

export const TimeEntry = z.object({
  id: z.string(),
  userId: z.string(),
  clockInAt: IsoDateTime,
  /** null = still open */
  clockOutAt: IsoDateTime.nullable(),
  /** Shop-local date the entry started on, "YYYY-MM-DD". */
  localDate: LocalDate,
  /** Whole minutes, floor((out - in) / 60s). For an open entry: elapsed until the server's `now`. */
  durationMinutes: z.number().int().min(0),
  source: TimeEntrySource,
  /** "DEACTIVATED" = closed automatically on deactivation ("Closed on deactivation"). */
  closedReason: z.enum(['DEACTIVATED']).nullable(),
  /** durationMinutes > LONG_SHIFT_MINUTES ("Long shift"). */
  flaggedLong: z.boolean(),
  /** Open and its shop-local start day has ended ("Still open"). */
  stillOpen: z.boolean(),
  /** Last manual correction (full history is in the audit log); null = never edited. */
  edited: z
    .object({ at: IsoDateTime, byUserId: z.string().nullable(), byName: z.string().nullable(), reason: z.string() })
    .nullable(),
});
export type TimeEntry = z.infer<typeof TimeEntry>;

// ---------- Self clock ----------

/**
 * GET /api/timeclock/me · permission `timeclock.self` → 200 `TimeclockStatus`.
 * POST /api/timeclock/clock-in · permission `timeclock.self`, no body (server time only) → 200 `TimeclockStatus`.
 *   Errors: 409 ALREADY_CLOCKED_IN. Not audited.
 * POST /api/timeclock/clock-out · permission `timeclock.self`, no body → 200 `TimeclockStatus`.
 *   Errors: 409 NOT_CLOCKED_IN. Not audited.
 * Scope is the active shop only.
 */
export const TimeclockStatus = z.object({
  serverNow: IsoDateTime,
  openEntry: TimeEntry.nullable(),
  /** Minutes worked today (shop-local), including the open entry. For the "Clocked out. 7h 52m today." toast. */
  todayMinutes: z.number().int().min(0),
  /** "My hours": own entries for this week and last week (shop-local, week starts Monday), newest first. */
  recentEntries: z.array(TimeEntry),
});
export type TimeclockStatus = z.infer<typeof TimeclockStatus>;

export const TIMECLOCK_PATHS = {
  me: '/api/timeclock/me',
  clockIn: '/api/timeclock/clock-in',
  clockOut: '/api/timeclock/clock-out',
} as const;

// ---------- Timesheets ----------

const dateRange = <T extends { from: string; to: string }>(v: T, ctx: z.RefinementCtx) => {
  if (v.to < v.from) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'End date must be on or after start date' });
  } else if (daysInRange(v.from, v.to) > MAX_TIMESHEET_RANGE_DAYS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['to'],
      message: `Choose a range of ${MAX_TIMESHEET_RANGE_DAYS} days or fewer`,
    });
  }
};

/**
 * GET /api/timesheets?from=YYYY-MM-DD&to=YYYY-MM-DD&userId=&needsReview= · permission `timesheet.view`
 * → 200 `TimesheetResponse`. `from`/`to` are inclusive shop-local dates, ≤ 93 days (else 400 VALIDATION_FAILED).
 * `userId` filters to one person (incl. deactivated people). `needsReview=true` keeps only flagged entries.
 *
 * GET /api/timesheets/export.csv (same query) · permission `timesheet.export` → 200 `text/csv; charset=utf-8`,
 * UTF-8 with BOM, `Content-Disposition: attachment; filename="timesheet-{shop-slug}-{from}-{to}.csv"`,
 * columns `TIMESHEET_CSV_COLUMNS`, one row per entry; cells escaped with `csvCell`. Audits `timesheet.exported`.
 */
export const TimesheetQuery = z
  .object({
    from: LocalDate,
    to: LocalDate,
    userId: z.string().min(1).optional(),
    needsReview: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .optional()
      .transform((v) => v === true || v === 'true'),
  })
  .superRefine(dateRange);
export type TimesheetQuery = z.infer<typeof TimesheetQuery>;

export const TimesheetDay = z.object({
  date: LocalDate,
  totalMinutes: z.number().int().min(0),
  entries: z.array(TimeEntry),
});
export type TimesheetDay = z.infer<typeof TimesheetDay>;

export const TimesheetStaff = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  role: Role,
  /** ACTIVE or DEACTIVATED (deactivated people with entries in range are included) */
  status: StaffStatus,
  totalMinutes: z.number().int().min(0),
  /** Only days with entries, ascending. */
  days: z.array(TimesheetDay),
});
export type TimesheetStaff = z.infer<typeof TimesheetStaff>;

export const TimesheetResponse = z.object({
  from: LocalDate,
  to: LocalDate,
  /** Shop timezone the dates/day boundaries use. */
  timezone: z.string(),
  serverNow: IsoDateTime,
  /** People with at least one entry in range, sorted by name. */
  staff: z.array(TimesheetStaff),
  /** Entries in range (ignoring the needsReview filter) with flaggedLong || stillOpen. */
  needsReviewCount: z.number().int().min(0),
});
export type TimesheetResponse = z.infer<typeof TimesheetResponse>;

export const TIMESHEET_EXPORT_PATH = '/api/timesheets/export.csv';

export const TIMESHEET_CSV_COLUMNS = [
  'Staff name',
  'Email',
  'Role',
  'Date',
  'Clock in',
  'Clock out',
  'Duration (hours)',
  'Duration (minutes)',
  'Flags',
  'Edited',
  'Edit reason',
] as const;

/** Escapes one CSV cell: neutralises formula injection (= + - @, tab, CR) and quotes when needed. */
export function csvCell(value: string | number | null | undefined): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** `timesheet-{slug}-{from}-{to}.csv` */
export function timesheetCsvFilename(shopName: string, from: string, to: string): string {
  const slug =
    shopName
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'shop';
  return `timesheet-${slug}-${from}-${to}.csv`;
}

// ---------- Corrections (timesheet.edit + canEditTimeEntry) ----------

const entryTimes = (v: { clockInAt?: string; clockOutAt?: string }, ctx: z.RefinementCtx) => {
  if (!v.clockInAt || !v.clockOutAt) return;
  const minutes = (Date.parse(v.clockOutAt) - Date.parse(v.clockInAt)) / 60_000;
  if (minutes <= 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['clockOutAt'], message: 'Clock-out must be after clock-in' });
  } else if (minutes > MAX_ENTRY_MINUTES) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['clockOutAt'], message: 'An entry can be at most 24 hours' });
  }
};

/**
 * POST /api/time-entries · permission `timesheet.edit` → 201 `TimeEntry` (source MANUAL). Audits `time_entry.created`.
 * API also checks: target is a member (active or deactivated) of the shop, `canEditTimeEntry(actor, targetRole, isSelf)`,
 * not in the future, no overlap.
 * Errors: 400 VALIDATION_FAILED, 403 FORBIDDEN, 404 NOT_FOUND (user not in shop), 409 TIME_ENTRY_OVERLAP.
 */
export const CreateTimeEntryInput = z
  .object({ userId: z.string().min(1), clockInAt: IsoDateTime, clockOutAt: IsoDateTime, reason: Reason })
  .strict()
  .superRefine(entryTimes);
export type CreateTimeEntryInput = z.infer<typeof CreateTimeEntryInput>;

/**
 * PATCH /api/time-entries/:id · permission `timesheet.edit` → 200 `TimeEntry`. Audits `time_entry.updated`
 * (before/after times + reason). Setting `clockOutAt` on an open entry closes it.
 * API checks the merged result: out > in, ≤ 24h, not in the future, no overlap.
 * Errors: 400 VALIDATION_FAILED, 403 FORBIDDEN (incl. a Manager's own or an Owner's entry), 404 NOT_FOUND,
 * 409 TIME_ENTRY_OVERLAP.
 */
export const UpdateTimeEntryInput = z
  .object({ clockInAt: IsoDateTime.optional(), clockOutAt: IsoDateTime.optional(), reason: Reason })
  .strict()
  .refine((v) => v.clockInAt !== undefined || v.clockOutAt !== undefined, {
    message: 'Change the clock-in or clock-out time',
    path: ['clockInAt'],
  })
  .superRefine(entryTimes);
export type UpdateTimeEntryInput = z.infer<typeof UpdateTimeEntryInput>;

/**
 * DELETE /api/time-entries/:id with JSON body `{ reason }` · permission `timesheet.edit` → 204 No Content.
 * Hard delete; audits `time_entry.deleted` with the before snapshot + reason.
 * Errors: 400 VALIDATION_FAILED, 403 FORBIDDEN, 404 NOT_FOUND.
 */
export const DeleteTimeEntryInput = z.object({ reason: Reason }).strict();
export type DeleteTimeEntryInput = z.infer<typeof DeleteTimeEntryInput>;

/** "7h 52m" (whole minutes). */
export function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  return `${Math.floor(m / 60)}h ${String(m % 60)}m`;
}

/** 472 → "7.87" (2 decimals, for CSV). */
export function decimalHours(minutes: number): string {
  return (Math.round((minutes / 60) * 100) / 100).toFixed(2);
}
