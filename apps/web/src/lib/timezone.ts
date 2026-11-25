/**
 * Shop-time helpers. Instants travel as UTC ISO strings; the UI shows and edits them in the
 * shop's IANA time zone. Calendar dates are "YYYY-MM-DD" strings (shop-local).
 */

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = partsFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFormatters.set(timeZone, fmt);
  }
  return fmt;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClock(utcMs: number, timeZone: string): WallClock {
  const parts = partsFormatter(timeZone).formatToParts(new Date(utcMs));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

/** Offset of `timeZone` from UTC at an instant, in ms (e.g. +3_600_000 for BST). */
export function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const whole = Math.floor(utcMs / 1000) * 1000;
  const w = wallClock(whole, timeZone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - whole;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** UTC ISO → shop-local "YYYY-MM-DDTHH:mm". */
export function utcToZonedLocal(iso: string, timeZone: string): string {
  const w = wallClock(Date.parse(iso), timeZone);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}`;
}

/**
 * Shop-local "YYYY-MM-DDTHH:mm[:ss]" → UTC ISO. In a DST gap the time is moved forward by the gap;
 * an ambiguous (repeated) hour resolves to the earlier instant.
 */
export function zonedLocalToUtc(local: string, timeZone: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local);
  if (!m) throw new RangeError(`Not a local date-time: ${local}`);
  const guess = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0));
  const offBefore = zoneOffsetMs(guess - 86_400_000, timeZone);
  const offAfter = zoneOffsetMs(guess + 86_400_000, timeZone);
  const wanted = local.slice(0, 16);
  const exact = [guess - offBefore, guess - offAfter]
    .filter((c) => utcToZonedLocal(new Date(c).toISOString(), timeZone) === wanted)
    .sort((a, b) => a - b)[0];
  // No exact match = a DST gap: read the wall time with the pre-change offset (moves it forward).
  return new Date(exact ?? guess - offBefore).toISOString();
}

/** Today's shop-local date "YYYY-MM-DD". */
export function todayInZone(timeZone: string, now: number = Date.now()): string {
  return utcToZonedLocal(new Date(now).toISOString(), timeZone).slice(0, 10);
}

function dateToUtcMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

export function addDays(date: string, days: number): string {
  return new Date(dateToUtcMs(date) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Monday of the week containing `date`. */
export function startOfWeekMonday(date: string): string {
  const dow = new Date(dateToUtcMs(date)).getUTCDay(); // 0 = Sunday
  return addDays(date, -((dow + 6) % 7));
}

export interface LocalDateRange {
  from: string;
  to: string;
}

export function thisWeek(today: string): LocalDateRange {
  const from = startOfWeekMonday(today);
  return { from, to: addDays(from, 6) };
}

export function lastWeek(today: string): LocalDateRange {
  const from = addDays(startOfWeekMonday(today), -7);
  return { from, to: addDays(from, 6) };
}

export function thisMonth(today: string): LocalDateRange {
  const from = `${today.slice(0, 8)}01`;
  return { from, to: lastDayOfMonth(from) };
}

export function lastMonth(today: string): LocalDateRange {
  const from = `${addDays(`${today.slice(0, 8)}01`, -1).slice(0, 8)}01`;
  return { from, to: lastDayOfMonth(from) };
}

function lastDayOfMonth(firstOfMonth: string): string {
  const d = new Date(dateToUtcMs(firstOfMonth));
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}

// ---------- Display ----------

export interface ShopClock {
  timezone: string;
  locale: string;
}

/** "09:30" (en-GB) / "9:30 AM" (en-US) in shop time. */
export function formatTime(iso: string, shop: ShopClock): string {
  return new Intl.DateTimeFormat(shop.locale, {
    timeZone: shop.timezone,
    hour: hourStyle(shop.locale),
    minute: '2-digit',
  }).format(new Date(iso));
}

/** "Mon 24 Nov 2026" / "Mon, Nov 24, 2026" for a shop-local date. */
export function formatLocalDate(date: string, locale: string, withYear = true): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(withYear ? { year: 'numeric' } : {}),
  }).format(new Date(`${date}T12:00:00Z`));
}

/** Instant as a short date + time in shop time, e.g. "24 Nov 2026, 09:30". */
export function formatDateTime(iso: string, shop: ShopClock): string {
  return new Intl.DateTimeFormat(shop.locale, {
    timeZone: shop.timezone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: hourStyle(shop.locale),
    minute: '2-digit',
  }).format(new Date(iso));
}

/** Instant as a long date in shop time, e.g. "2 December 2026". */
export function formatLongDate(iso: string, shop: ShopClock): string {
  return new Intl.DateTimeFormat(shop.locale, {
    timeZone: shop.timezone,
    dateStyle: 'long',
  }).format(new Date(iso));
}

/** "Mon 09:00" style day + time for warnings. */
export function formatDayTime(iso: string, shop: ShopClock): string {
  return new Intl.DateTimeFormat(shop.locale, {
    timeZone: shop.timezone,
    weekday: 'short',
    hour: hourStyle(shop.locale),
    minute: '2-digit',
  }).format(new Date(iso));
}

function hourStyle(locale: string): 'numeric' | '2-digit' {
  return hourFormatFor(locale) === '12h' ? 'numeric' : '2-digit';
}

/** 12h for en-US, 24h otherwise (matches the story's display rule). */
export function hourFormatFor(locale: string): '12h' | '24h' {
  return locale === 'en-US' ? '12h' : '24h';
}

/** Instant as a short date in shop time, e.g. "23 Nov 2026" (dense tables). */
export function formatShortDate(iso: string, shop: ShopClock): string {
  return new Intl.DateTimeFormat(shop.locale, {
    timeZone: shop.timezone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(iso));
}
