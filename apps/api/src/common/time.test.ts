import { describe, expect, it } from 'vitest';
import { addDays, localDateOf, localRange, localTimeOf, mondayOf, startOfLocalDay } from './time';

describe('shop timezone helpers', () => {
  it('PK (UTC+5, no DST): day starts at 19:00 UTC the day before', () => {
    expect(startOfLocalDay('2026-11-11', 'Asia/Karachi').toISOString()).toBe('2026-11-10T19:00:00.000Z');
    expect(localDateOf(new Date('2026-11-10T18:59:59Z'), 'Asia/Karachi')).toBe('2026-11-10');
    expect(localDateOf(new Date('2026-11-10T19:00:00Z'), 'Asia/Karachi')).toBe('2026-11-11');
    expect(localTimeOf(new Date('2026-11-10T19:30:00Z'), 'Asia/Karachi')).toBe('00:30');
  });

  it('US Eastern across DST: EST is UTC-5, EDT is UTC-4; the spring-forward day is 23h', () => {
    expect(startOfLocalDay('2026-03-08', 'America/New_York').toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(startOfLocalDay('2026-03-09', 'America/New_York').toISOString()).toBe('2026-03-09T04:00:00.000Z');
    const { start, end } = localRange('2026-03-08', '2026-03-08', 'America/New_York');
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(23);
    const fall = localRange('2026-11-01', '2026-11-01', 'America/New_York');
    expect((fall.end.getTime() - fall.start.getTime()) / 3_600_000).toBe(25);
  });

  it('UK across BST', () => {
    expect(startOfLocalDay('2026-03-29', 'Europe/London').toISOString()).toBe('2026-03-29T00:00:00.000Z');
    expect(startOfLocalDay('2026-03-30', 'Europe/London').toISOString()).toBe('2026-03-29T23:00:00.000Z');
    expect(localTimeOf(new Date('2026-06-01T12:00:00Z'), 'Europe/London')).toBe('13:00');
  });

  it('date arithmetic and Monday-start weeks', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(mondayOf('2026-11-25')).toBe('2026-11-23'); // Wednesday
    expect(mondayOf('2026-11-29')).toBe('2026-11-23'); // Sunday
    expect(mondayOf('2026-11-23')).toBe('2026-11-23');
  });
});
