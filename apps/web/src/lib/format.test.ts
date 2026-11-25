import { describe, expect, it } from 'vitest';
import { describeTaxDefaults, displayFractionDigits, formatMoney, formatRateBps } from './format';

describe('formatMoney', () => {
  it('formats USD minor units with two decimals in en-US', () => {
    expect(formatMoney(12950, { currency: 'USD', locale: 'en-US' })).toBe('$129.50');
    expect(formatMoney(0, { currency: 'USD', locale: 'en-US' })).toBe('$0.00');
    expect(formatMoney(123456789, { currency: 'USD', locale: 'en-US' })).toBe('$1,234,567.89');
  });

  it('formats GBP in en-GB', () => {
    expect(formatMoney(4000, { currency: 'GBP', locale: 'en-GB' })).toBe('£40.00');
    expect(formatMoney(5, { currency: 'GBP', locale: 'en-GB' })).toBe('£0.05');
  });

  it('shows PKR without decimals and with the Rs symbol', () => {
    expect(formatMoney(499900, { currency: 'PKR', locale: 'en-GB' })).toBe('Rs\u00a04,999');
    // Storage is still 2-digit minor units (paisa): 150 paisa = Rs 1.50, shown rounded.
    expect(formatMoney(150, { currency: 'PKR', locale: 'en-GB' })).toBe('Rs\u00a02');
    expect(formatMoney(149, { currency: 'PKR', locale: 'en-GB' })).toBe('Rs\u00a01');
  });

  it('formats negative amounts (refunds)', () => {
    expect(formatMoney(-2500, { currency: 'USD', locale: 'en-US' })).toBe('-$25.00');
  });

  it('rejects non-integer minor units', () => {
    expect(() => formatMoney(12.5, { currency: 'USD', locale: 'en-US' })).toThrow(RangeError);
    expect(() => formatMoney(Number.NaN, { currency: 'USD', locale: 'en-US' })).toThrow(RangeError);
  });

  it('falls back to en-US for an invalid locale', () => {
    expect(formatMoney(100, { currency: 'USD', locale: 'not a locale!' })).toBe('$1.00');
  });
});

describe('displayFractionDigits', () => {
  it('reads display digits from MARKET_DEFAULTS', () => {
    expect(displayFractionDigits('USD')).toBe(2);
    expect(displayFractionDigits('GBP')).toBe(2);
    expect(displayFractionDigits('PKR')).toBe(0);
  });
});

describe('tax helpers', () => {
  it('formats basis points as a percentage', () => {
    expect(formatRateBps(2000)).toBe('20%');
    expect(formatRateBps(888)).toBe('8.88%');
    expect(formatRateBps(0)).toBe('0%');
  });

  it('describes each market default', () => {
    expect(describeTaxDefaults('GB')).toBe('Prices include VAT 20%');
    expect(describeTaxDefaults('US')).toBe(
      'Prices exclude sales tax. Add your local rate in Settings.',
    );
    expect(describeTaxDefaults('PK')).toBe(
      'Prices exclude tax: GST 18% on goods, Sales tax on services 16%',
    );
  });
});
