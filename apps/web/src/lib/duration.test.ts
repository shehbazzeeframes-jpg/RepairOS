import { describe, expect, it } from 'vitest';
import { clockedInLabel, formatShortDuration, minutesBetween } from './duration';

describe('duration formatting', () => {
  it('counts whole elapsed minutes and never goes negative', () => {
    expect(minutesBetween(0, 59_999)).toBe(0);
    expect(minutesBetween(0, 60_000)).toBe(1);
    expect(minutesBetween(0, (2 * 60 + 14) * 60_000 + 30_000)).toBe(134);
    expect(minutesBetween(10_000, 0)).toBe(0);
  });

  it('shows minutes alone under an hour', () => {
    expect(formatShortDuration(0)).toBe('0m');
    expect(formatShortDuration(14)).toBe('14m');
    expect(formatShortDuration(59.9)).toBe('59m');
  });

  it('shows hours and minutes from an hour', () => {
    expect(formatShortDuration(60)).toBe('1h 0m');
    expect(formatShortDuration(134)).toBe('2h 14m');
    expect(formatShortDuration(15 * 60 + 2)).toBe('15h 2m');
  });

  it('builds the top-bar label', () => {
    expect(clockedInLabel(134)).toBe('Clocked in 2h 14m');
    expect(clockedInLabel(-5)).toBe('Clocked in 0m');
  });
});
