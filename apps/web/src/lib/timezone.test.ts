import { describe, expect, it } from 'vitest';
import {
  addDays,
  formatTime,
  lastMonth,
  lastWeek,
  startOfWeekMonday,
  thisMonth,
  thisWeek,
  todayInZone,
  utcToZonedLocal,
  zonedLocalToUtc,
} from './timezone';

describe('shop-time conversion', () => {
  it('round-trips London winter and summer time', () => {
    expect(zonedLocalToUtc('2026-01-15T09:00', 'Europe/London')).toBe('2026-01-15T09:00:00.000Z');
    expect(zonedLocalToUtc('2026-07-15T09:00', 'Europe/London')).toBe('2026-07-15T08:00:00.000Z');
    expect(utcToZonedLocal('2026-07-15T08:00:00.000Z', 'Europe/London')).toBe('2026-07-15T09:00');
  });

  it('handles New York and Karachi', () => {
    expect(zonedLocalToUtc('2026-11-24T18:30', 'America/New_York')).toBe('2026-11-24T23:30:00.000Z');
    expect(zonedLocalToUtc('2026-11-24T10:00', 'Asia/Karachi')).toBe('2026-11-24T05:00:00.000Z');
    expect(utcToZonedLocal('2026-11-24T23:30:00.000Z', 'America/New_York')).toBe('2026-11-24T18:30');
  });

  it('moves a time in the spring-forward gap forward and picks the earlier repeated hour', () => {
    // 2026-03-29 01:30 does not exist in London (clocks go 01:00 → 02:00).
    expect(zonedLocalToUtc('2026-03-29T01:30', 'Europe/London')).toBe('2026-03-29T01:30:00.000Z');
    // 2026-10-25 01:30 happens twice; take the first (BST).
    expect(zonedLocalToUtc('2026-10-25T01:30', 'Europe/London')).toBe('2026-10-25T00:30:00.000Z');
  });

  it('finds today in the shop zone', () => {
    const lateNightNY = Date.parse('2026-11-25T03:00:00Z'); // 22:00 on the 24th in New York
    expect(todayInZone('America/New_York', lateNightNY)).toBe('2026-11-24');
    expect(todayInZone('Asia/Karachi', lateNightNY)).toBe('2026-11-25');
  });

  it('formats times in the shop locale', () => {
    const shopUS = { timezone: 'America/New_York', locale: 'en-US' };
    const shopGB = { timezone: 'Europe/London', locale: 'en-GB' };
    expect(formatTime('2026-11-24T14:05:00Z', shopUS)).toBe('9:05 AM');
    expect(formatTime('2026-11-24T14:05:00Z', shopGB)).toBe('14:05');
  });
});

describe('date presets (weeks start Monday)', () => {
  const today = '2026-11-25'; // Wednesday
  it('computes week and month ranges', () => {
    expect(startOfWeekMonday(today)).toBe('2026-11-23');
    expect(startOfWeekMonday('2026-11-29')).toBe('2026-11-23'); // Sunday
    expect(thisWeek(today)).toEqual({ from: '2026-11-23', to: '2026-11-29' });
    expect(lastWeek(today)).toEqual({ from: '2026-11-16', to: '2026-11-22' });
    expect(thisMonth(today)).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(lastMonth(today)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(lastMonth('2026-03-10')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});
