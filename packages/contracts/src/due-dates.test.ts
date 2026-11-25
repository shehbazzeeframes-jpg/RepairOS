import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUSINESS_HOURS,
  addOpenDays,
  closingTimeOn,
  computeDefaultDueAt,
  dueAtFor,
  dueInputProblem,
  isDueToday,
  isOverdue,
  localDateInZone,
  localDayRange,
  zonedTimeToUtc,
  type HoursDayLike,
} from './index';

// Mon–Sat 10:00–19:00, Sunday closed (D9)
const hours = DEFAULT_BUSINESS_HOURS;
const NY = 'America/New_York';
const LDN = 'Europe/London';
const KHI = 'Asia/Karachi';

describe('zonedTimeToUtc', () => {
  it('converts wall-clock time in winter and summer', () => {
    expect(zonedTimeToUtc('2026-01-15', '19:00', NY).toISOString()).toBe('2026-01-16T00:00:00.000Z');
    expect(zonedTimeToUtc('2026-07-15', '19:00', NY).toISOString()).toBe('2026-07-15T23:00:00.000Z');
    expect(zonedTimeToUtc('2026-07-15', '19:00', LDN).toISOString()).toBe('2026-07-15T18:00:00.000Z');
    expect(zonedTimeToUtc('2026-01-15', '19:00', LDN).toISOString()).toBe('2026-01-15T19:00:00.000Z');
    expect(zonedTimeToUtc('2026-07-15', '19:00', KHI).toISOString()).toBe('2026-07-15T14:00:00.000Z');
  });
  it('spring-forward gap resolves to the later instant; fall-back overlap to the earlier', () => {
    // 2026-03-08 02:30 doesn't exist in New York → 03:30 EDT
    expect(zonedTimeToUtc('2026-03-08', '02:30', NY).toISOString()).toBe('2026-03-08T07:30:00.000Z');
    // 2026-11-01 01:30 happens twice in New York → first (EDT)
    expect(zonedTimeToUtc('2026-11-01', '01:30', NY).toISOString()).toBe('2026-11-01T05:30:00.000Z');
    // 2026-03-29 01:30 doesn't exist in London → 02:30 BST
    expect(zonedTimeToUtc('2026-03-29', '01:30', LDN).toISOString()).toBe('2026-03-29T01:30:00.000Z');
    // 2026-10-25 01:30 happens twice in London → first (BST)
    expect(zonedTimeToUtc('2026-10-25', '01:30', LDN).toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });
  it('local date of an instant and day ranges', () => {
    expect(localDateInZone(new Date('2026-06-01T23:30:00Z'), LDN)).toBe('2026-06-02');
    expect(localDateInZone(new Date('2026-06-02T03:30:00Z'), NY)).toBe('2026-06-01');
    const r = localDayRange('2026-03-08', NY); // 23-hour day
    expect((r.end.getTime() - r.start.getTime()) / 3_600_000).toBe(23);
  });
});

describe('open days and closing time', () => {
  it('skips closed days; 0 = same day', () => {
    expect(addOpenDays('2026-11-27', 2, hours)).toBe('2026-11-30'); // Fri → Sat(1), Sun closed, Mon(2)
    expect(addOpenDays('2026-11-28', 2, hours)).toBe('2026-12-01'); // Sat → Mon, Tue
    expect(addOpenDays('2026-11-29', 0, hours)).toBe('2026-11-29'); // Sunday, 0 days
    expect(addOpenDays('2026-11-29', 1, hours)).toBe('2026-11-30');
  });
  it('no open days or no hours → calendar days', () => {
    const allClosed: HoursDayLike[] = hours.map((d) => ({ ...d, isOpen: false, closesAt: null }));
    expect(addOpenDays('2026-11-27', 2, allClosed)).toBe('2026-11-29');
    expect(addOpenDays('2026-11-27', 3, null)).toBe('2026-11-30');
  });
  it('closing time of the day, 23:59 when closed or unknown', () => {
    expect(closingTimeOn('2026-11-27', hours)).toBe('19:00');
    expect(closingTimeOn('2026-11-29', hours)).toBe('23:59');
    expect(closingTimeOn('2026-11-29', undefined)).toBe('23:59');
  });
});

describe('computeDefaultDueAt (A16) across DST', () => {
  it('US: Friday + 2 open days crosses spring-forward and lands at Monday closing time (EDT)', () => {
    const now = new Date('2026-03-06T20:00:00Z'); // Fri 15:00 EST
    expect(computeDefaultDueAt(now, 2, hours, NY)).toEqual({
      dueAt: '2026-03-09T23:00:00.000Z', // Mon 19:00 EDT
      date: '2026-03-09',
      time: null,
      dueHasTime: false,
    });
  });
  it('US: across fall-back lands at closing time in EST', () => {
    const now = new Date('2026-10-30T16:00:00Z'); // Fri 12:00 EDT
    expect(computeDefaultDueAt(now, 2, hours, NY).dueAt).toBe('2026-11-03T00:00:00.000Z'); // Mon 2 Nov 19:00 EST
  });
  it('UK: across BST start and end', () => {
    expect(computeDefaultDueAt(new Date('2026-03-27T12:00:00Z'), 2, hours, LDN).dueAt).toBe('2026-03-30T18:00:00.000Z'); // Mon 19:00 BST
    expect(computeDefaultDueAt(new Date('2026-10-23T11:00:00Z'), 2, hours, LDN).dueAt).toBe('2026-10-26T19:00:00.000Z'); // Mon 19:00 GMT
  });
  it('"today" is the shop-local date, not UTC', () => {
    // 2026-11-28 02:00Z is still Friday 27 Nov in New York → +1 open day = Saturday
    expect(computeDefaultDueAt(new Date('2026-11-28T02:00:00Z'), 1, hours, NY).date).toBe('2026-11-28');
  });
  it('same-day on a closed day uses 23:59; PK has no DST', () => {
    expect(computeDefaultDueAt(new Date('2026-11-29T15:00:00Z'), 0, hours, LDN).dueAt).toBe('2026-11-29T23:59:00.000Z');
    expect(computeDefaultDueAt(new Date('2026-06-05T06:00:00Z'), 2, hours, KHI).dueAt).toBe('2026-06-08T14:00:00.000Z');
  });
});

describe('dueAtFor / dueInputProblem', () => {
  it('date-only → closing time; with time → that time', () => {
    expect(dueAtFor('2026-11-30', null, hours, LDN)).toMatchObject({ dueAt: '2026-11-30T19:00:00.000Z', dueHasTime: false });
    expect(dueAtFor('2026-11-30', '12:30', hours, LDN)).toMatchObject({ dueAt: '2026-11-30T12:30:00.000Z', dueHasTime: true, time: '12:30' });
  });
  it('rejects past dates and earlier-today times in the shop zone', () => {
    const now = new Date('2026-11-25T15:00:00Z'); // 10:00 in New York
    expect(dueInputProblem('2026-11-24', null, now, NY)).toBe("Due date can't be in the past");
    expect(dueInputProblem('2026-11-25', null, now, NY)).toBeNull();
    expect(dueInputProblem('2026-11-25', '09:00', now, NY)).toBe('Choose a time later than now');
    expect(dueInputProblem('2026-11-25', '11:00', now, NY)).toBeNull();
  });
});

describe('overdue and due today (DU1.2–3)', () => {
  const now = new Date('2026-06-02T10:00:00Z');
  it('only OPEN/WAITING can be overdue', () => {
    const past = '2026-06-02T09:00:00Z';
    expect(isOverdue({ statusCategory: 'OPEN', dueAt: past }, now)).toBe(true);
    expect(isOverdue({ statusCategory: 'WAITING', dueAt: past }, now)).toBe(true);
    expect(isOverdue({ statusCategory: 'READY', dueAt: past }, now)).toBe(false);
    expect(isOverdue({ statusCategory: 'CLOSED', dueAt: past }, now)).toBe(false);
    expect(isOverdue({ statusCategory: 'OPEN', dueAt: '2026-06-02T10:00:01Z' }, now)).toBe(false);
  });
  it('due today uses the shop-local date and includes overdue-today', () => {
    // 23:30Z on 1 June = 00:30 BST on 2 June
    expect(isDueToday({ statusCategory: 'OPEN', dueAt: '2026-06-01T23:30:00Z' }, now, LDN)).toBe(true);
    expect(isDueToday({ statusCategory: 'OPEN', dueAt: '2026-06-01T22:30:00Z' }, now, LDN)).toBe(false);
    expect(isDueToday({ statusCategory: 'OPEN', dueAt: '2026-06-02T18:00:00Z' }, now, LDN)).toBe(true);
    expect(isDueToday({ statusCategory: 'READY', dueAt: '2026-06-02T18:00:00Z' }, now, LDN)).toBe(false);
  });
});
