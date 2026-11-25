import type { StatusCategory } from './ticket-statuses';

/**
 * Due dates, overdue and "due today" in the shop's timezone (Sprint 2 story §5.5 DU1, decision A16).
 * Pure functions on UTC instants + an IANA zone, DST-correct via `Intl` (no dependency).
 *
 * Rules:
 * - `dueAt` is a UTC instant. Date-only dues (`dueHasTime = false`) are set to that date's CLOSING time from business
 *   hours in the shop zone, or 23:59 when the day is closed or hours are missing.
 * - Default due = today (shop-local) + N **open** days (closed days skipped); N = 0 → today. If the shop has no open
 *   day at all (or no hours), N calendar days are added.
 * - Overdue = category OPEN or WAITING and `dueAt < now`. Due today = OPEN or WAITING and `dueAt` is on today's
 *   shop-local date (overdue-today included). READY and CLOSED are never overdue / due today.
 */

/** Minimal business-hours shape (compatible with `BusinessHoursWeek`). `weekday` 0 = Sunday … 6 = Saturday. */
export interface HoursDayLike {
  weekday: number;
  isOpen: boolean;
  opensAt?: string | null;
  closesAt: string | null;
}

/** Closing time used when the day is closed or hours are missing. */
export const FALLBACK_DUE_TIME = '23:59';

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(timeZone: string): Intl.DateTimeFormat {
  let f = dtfCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dtfCache.set(timeZone, f);
  }
  return f;
}

/** Wall-clock parts of `instant` in `timeZone`. */
export function zonedParts(instant: Date, timeZone: string): { date: string; time: string; weekday: number } {
  const parts = Object.fromEntries(dtf(timeZone).formatToParts(instant).map((p) => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { date, time: `${parts.hour}:${parts.minute}`, weekday: weekdayOf(date) };
}

/** Shop-local calendar date "YYYY-MM-DD" of an instant. */
export function localDateInZone(instant: Date, timeZone: string): string {
  return zonedParts(instant, timeZone).date;
}

/** 0 = Sunday … 6 = Saturday for a "YYYY-MM-DD" date. */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** "YYYY-MM-DD" + n calendar days. */
export function addCalendarDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Offset of `timeZone` from UTC at `instant`, in minutes (e.g. London summer = +60, New York winter = -300). */
function offsetMinutes(instant: number, timeZone: string): number {
  const p = Object.fromEntries(dtf(timeZone).formatToParts(new Date(instant)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return Math.round((asUtc - Math.floor(instant / 1000) * 1000) / 60_000);
}

/**
 * The UTC instant of a shop-local wall-clock time. In a spring-forward gap the later valid instant is used
 * (02:30 that doesn't exist → 03:30); in a fall-back overlap the earlier one.
 */
export function zonedTimeToUtc(date: string, time: string, timeZone: string): Date {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi] = time.split(':').map(Number) as [number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const o1 = offsetMinutes(wall, timeZone);
  let t = wall - o1 * 60_000;
  const o2 = offsetMinutes(t, timeZone);
  if (o2 !== o1) {
    const t2 = wall - o2 * 60_000;
    // t2 is consistent when its own offset is o2 (normal case); otherwise we are in a gap → keep the later instant.
    t = offsetMinutes(t2, timeZone) === o2 ? t2 : Math.max(t, t2);
  } else {
    // fall-back overlap: prefer the earlier instant if it maps to the same wall time
    const earlier = t - 60 * 60_000;
    const p = zonedParts(new Date(earlier), timeZone);
    if (p.date === date && p.time === time) t = earlier;
  }
  return new Date(t);
}

function dayHours(hours: readonly HoursDayLike[] | null | undefined, weekday: number): HoursDayLike | undefined {
  return hours?.find((h) => h.weekday === weekday);
}

/** Closing time "HH:mm" for a shop-local date, or `FALLBACK_DUE_TIME` when closed / no hours. */
export function closingTimeOn(date: string, hours: readonly HoursDayLike[] | null | undefined): string {
  const h = dayHours(hours, weekdayOf(date));
  return h?.isOpen && h.closesAt ? h.closesAt : FALLBACK_DUE_TIME;
}

/** True when business hours mark this date's weekday as open. */
export function isOpenDay(date: string, hours: readonly HoursDayLike[] | null | undefined): boolean {
  return !!dayHours(hours, weekdayOf(date))?.isOpen;
}

/**
 * `startDate` + N open days (closed days skipped). N = 0 → `startDate`. No open day at all (or no hours) → N
 * calendar days. Example (Sun closed): Sat + 2 → Tue.
 */
export function addOpenDays(startDate: string, n: number, hours: readonly HoursDayLike[] | null | undefined): string {
  if (n <= 0) return startDate;
  if (!hours?.some((h) => h.isOpen)) return addCalendarDays(startDate, n);
  let date = startDate;
  let counted = 0;
  while (counted < n) {
    date = addCalendarDays(date, 1);
    if (isOpenDay(date, hours)) counted++;
  }
  return date;
}

export interface DueValue {
  /** UTC ISO instant */
  dueAt: string;
  /** Shop-local date */
  date: string;
  /** "HH:mm" shop-local, null for date-only */
  time: string | null;
  dueHasTime: boolean;
}

/**
 * The stored due for a chosen date (+ optional time) in the shop zone. Date-only → closing time of that day
 * (`closingTimeOn`), `dueHasTime = false`.
 */
export function dueAtFor(
  date: string,
  time: string | null | undefined,
  hours: readonly HoursDayLike[] | null | undefined,
  timeZone: string,
): DueValue {
  const wall = time ?? closingTimeOn(date, hours);
  return { dueAt: zonedTimeToUtc(date, wall, timeZone).toISOString(), date, time: time ?? null, dueHasTime: !!time };
}

/**
 * Check-in default (TK1.8, A16): shop-local today + `turnaroundDays` open days, at that day's closing time,
 * date-only. DST-safe (the closing time is resolved in the zone on the target date).
 */
export function computeDefaultDueAt(
  now: Date,
  turnaroundDays: number,
  hours: readonly HoursDayLike[] | null | undefined,
  timeZone: string,
): DueValue {
  const today = localDateInZone(now, timeZone);
  return dueAtFor(addOpenDays(today, turnaroundDays, hours), null, hours, timeZone);
}

/**
 * Validates a due chosen by a person (§5.1 edge case): a date before today → "Due date can't be in the past";
 * today with a time not later than now → "Choose a time later than now". Null when fine.
 * Not applied on reopen (a past due is allowed there and shows as overdue).
 */
export function dueInputProblem(date: string, time: string | null | undefined, now: Date, timeZone: string): string | null {
  const today = localDateInZone(now, timeZone);
  if (date < today) return "Due date can't be in the past";
  if (time && date === today && zonedTimeToUtc(date, time, timeZone).getTime() <= now.getTime()) {
    return 'Choose a time later than now';
  }
  return null;
}

interface DueTrackable {
  statusCategory: StatusCategory;
  dueAt: string | Date | null;
}

const dueMs = (d: string | Date) => (typeof d === 'string' ? Date.parse(d) : d.getTime());

/** OPEN or WAITING and `dueAt < now`. */
export function isOverdue(t: DueTrackable, now: Date = new Date()): boolean {
  return (t.statusCategory === 'OPEN' || t.statusCategory === 'WAITING') && t.dueAt !== null && dueMs(t.dueAt) < now.getTime();
}

/** OPEN or WAITING and `dueAt` on today's shop-local date (includes overdue-today, excludes earlier days). */
export function isDueToday(t: DueTrackable, now: Date, timeZone: string): boolean {
  if (!(t.statusCategory === 'OPEN' || t.statusCategory === 'WAITING') || t.dueAt === null) return false;
  return localDateInZone(new Date(dueMs(t.dueAt)), timeZone) === localDateInZone(now, timeZone);
}

/** UTC [start, end) of a shop-local date — for "due today" queries and date-range filters. */
export function localDayRange(date: string, timeZone: string): { start: Date; end: Date } {
  return { start: zonedTimeToUtc(date, '00:00', timeZone), end: zonedTimeToUtc(addCalendarDays(date, 1), '00:00', timeZone) };
}
