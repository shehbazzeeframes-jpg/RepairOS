import { describe, expect, it } from 'vitest';
import { CreateTaxRateInput, RatePercentInput, UpdateTaxRateInput, formatRate, parseRatePercent } from './index';

describe('parseRatePercent', () => {
  it.each([
    ['8.875', 8875],
    ['8.875%', 8875],
    [' 20 ', 20000],
    ['20 %', 20000],
    ['0', 0],
    ['0.5', 500],
    ['16.25', 16250],
    ['100', 100000],
    ['100.000', 100000],
  ])('%s → %d', (input, expected) => {
    expect(parseRatePercent(input)).toBe(expected);
  });
  it.each(['', 'abc', '8.8755', '100.001', '101', '-1', '8.', '.5', '1,5', '8.875%%'])('rejects %j', (input) => {
    expect(parseRatePercent(input)).toBeNull();
  });
});

describe('formatRate', () => {
  it('shows up to 3 decimals, trimmed', () => {
    expect(formatRate(8875)).toBe('8.875%');
    expect(formatRate(20000)).toBe('20%');
    expect(formatRate(16500)).toBe('16.5%');
    expect(formatRate(0)).toBe('0%');
    expect(formatRate(20000, 'en-GB')).toBe('20%');
  });
  it('round-trips with parseRatePercent', () => {
    for (const v of [0, 1, 875, 8875, 16250, 18000, 100000]) {
      expect(parseRatePercent(formatRate(v))).toBe(v);
    }
  });
});

describe('tax rate inputs', () => {
  it('RatePercentInput converts form text', () => {
    expect(RatePercentInput.parse('8.875%')).toBe(8875);
    expect(RatePercentInput.safeParse('8.8755').success).toBe(false);
  });
  it('a goods rate cannot be the services default (D1)', () => {
    const r = CreateTaxRateInput.safeParse({ name: 'GST', rateMilliPct: 18000, appliesTo: 'goods', isDefaultServices: true });
    expect(r.success).toBe(false);
    expect(
      CreateTaxRateInput.safeParse({ name: 'VAT', rateMilliPct: 20000, appliesTo: 'all', isDefaultGoods: true, isDefaultServices: true }).success,
    ).toBe(true);
  });
  it('defaults can only be set (true), never unset directly', () => {
    expect(UpdateTaxRateInput.safeParse({ isDefaultGoods: false }).success).toBe(false);
    expect(UpdateTaxRateInput.safeParse({ isDefaultGoods: true }).success).toBe(true);
  });
  it('rejects out-of-range or fractional rates and empty updates', () => {
    expect(CreateTaxRateInput.safeParse({ name: 'X', rateMilliPct: 100001, appliesTo: 'all' }).success).toBe(false);
    expect(CreateTaxRateInput.safeParse({ name: 'X', rateMilliPct: 8.5, appliesTo: 'all' }).success).toBe(false);
    expect(UpdateTaxRateInput.safeParse({}).success).toBe(false);
  });
});
