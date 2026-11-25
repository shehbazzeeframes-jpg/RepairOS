import { describe, expect, it } from 'vitest';
import {
  CreateShopInput,
  TIMEZONES_BY_COUNTRY,
  formatPhone,
  normalizePhone,
  normalizePostcode,
  normalizeRegion,
  normalizeTimezone,
  shopProfileSchema,
  UpdateShopProfileInput,
} from './index';

describe('normalizePhone', () => {
  it.each([
    ['US', '(212) 555-0142', '+12125550142'],
    ['GB', '020 7946 0018', '+442079460018'],
    ['GB', '07911 123456', '+447911123456'],
    ['PK', '0300 1234567', '+923001234567'],
    ['PK', '042 35761234', '+924235761234'],
    ['US', '+44 20 7946 0018', '+442079460018'],
  ] as const)('%s %s → %s', (country, raw, e164) => {
    expect(normalizePhone(raw, country)).toBe(e164);
  });
  it('rejects invalid numbers and treats empty as null', () => {
    expect(normalizePhone('12', 'GB')).toBeNull();
    expect(normalizePhone('0300 12', 'PK')).toBeNull();
    expect(normalizePhone('', 'US')).toBeNull();
    expect(normalizePhone(undefined, 'US')).toBeNull();
  });
  it('formats national for the shop country', () => {
    expect(formatPhone('+12125550142', 'US')).toBe('(212) 555-0142');
    expect(formatPhone('+923001234567', 'PK')).toBe('0300 1234567');
    expect(formatPhone('+442079460018', 'US')).toBe('+44 20 7946 0018');
  });
  it('R7: compares by calling code, so UK ranges libphonenumber files under GG/JE/IM stay national', () => {
    expect(formatPhone('+447911123456', 'GB')).toBe('07911 123456'); // GB mobile (classified GG)
    expect(formatPhone('+442079460018', 'GB')).toBe('020 7946 0018'); // GB landline
    expect(formatPhone('+441534123456', 'GB')).toBe('01534 123456'); // real Jersey landline (JE, +44)
    expect(formatPhone('+447797123456', 'GB')).toBe('07797 123456'); // Jersey mobile
    expect(formatPhone('+441534123456', 'US')).toBe('+44 1534 123456');
    expect(formatPhone('+447911123456', 'PK')).toBe('+44 7911 123456');
    expect(formatPhone('+12125550142', 'US')).toBe('(212) 555-0142');
    expect(formatPhone('+12125550142', 'GB')).toBe('+1 212 555 0142');
    expect(formatPhone('+923001234567', 'PK')).toBe('0300 1234567');
    expect(formatPhone('+924235761234', 'PK')).toBe('(042) 35761234');
    expect(formatPhone('+923001234567', 'GB')).toBe('+92 300 1234567');
  });
});

describe('normalizePostcode', () => {
  it('US ZIP and ZIP+4', () => {
    expect(normalizePostcode('10001', 'US')).toBe('10001');
    expect(normalizePostcode('10001-1234', 'US')).toBe('10001-1234');
    expect(normalizePostcode('1000', 'US')).toBeNull();
    expect(normalizePostcode('10001 1234', 'US')).toBeNull();
  });
  it('UK postcodes are upper-cased with one space before the inward code', () => {
    expect(normalizePostcode('sw1a1aa', 'GB')).toBe('SW1A 1AA');
    expect(normalizePostcode(' M1  1AE ', 'GB')).toBe('M1 1AE');
    expect(normalizePostcode('EC1A 1BB', 'GB')).toBe('EC1A 1BB');
    expect(normalizePostcode('B33 8TH', 'GB')).toBe('B33 8TH');
    expect(normalizePostcode('GIR 0AA', 'GB')).toBe('GIR 0AA');
    expect(normalizePostcode('12345', 'GB')).toBeNull();
    expect(normalizePostcode('SW1A 1AI', 'GB')).toBeNull();
  });
  it('PK 5 digits', () => {
    expect(normalizePostcode('54000', 'PK')).toBe('54000');
    expect(normalizePostcode('5400', 'PK')).toBeNull();
    expect(normalizePostcode('54000-1234', 'PK')).toBeNull();
  });
});

describe('normalizeTimezone', () => {
  it('has 7 US zones and one each for GB and PK', () => {
    expect(TIMEZONES_BY_COUNTRY.US).toHaveLength(7);
    expect(TIMEZONES_BY_COUNTRY.GB.map((t) => t.value)).toEqual(['Europe/London']);
    expect(TIMEZONES_BY_COUNTRY.PK.map((t) => t.value)).toEqual(['Asia/Karachi']);
  });
  it('accepts allow-listed zones case-insensitively and returns the canonical name', () => {
    expect(normalizeTimezone('europe/london', 'GB')).toBe('Europe/London');
    expect(normalizeTimezone('Pacific/Honolulu', 'US')).toBe('Pacific/Honolulu');
  });
  it('rejects zones of other countries, unknown and offset zones', () => {
    expect(normalizeTimezone('Europe/London', 'US')).toBeNull();
    expect(normalizeTimezone('Asia/Dubai', 'PK')).toBeNull();
    expect(normalizeTimezone('Mars/Olympus_Mons', 'GB')).toBeNull();
    expect(normalizeTimezone('+05:00', 'PK')).toBeNull();
  });
  it('every allow-listed zone is a real IANA zone', () => {
    for (const list of Object.values(TIMEZONES_BY_COUNTRY)) {
      for (const tz of list) expect(() => new Intl.DateTimeFormat('en-US', { timeZone: tz.value })).not.toThrow();
    }
  });
});

describe('normalizeRegion', () => {
  it('US state codes (50 + DC), PK provinces, GB free text', () => {
    expect(normalizeRegion('ny', 'US')).toBe('NY');
    expect(normalizeRegion('DC', 'US')).toBe('DC');
    expect(normalizeRegion('XX', 'US')).toBeNull();
    expect(normalizeRegion('sindh', 'PK')).toBe('Sindh');
    expect(normalizeRegion('Texas', 'PK')).toBeNull();
    expect(normalizeRegion('Greater Manchester', 'GB')).toBe('Greater Manchester');
  });
});

describe('CreateShopInput', () => {
  it('normalises phone, postcode, region and timezone', () => {
    const out = CreateShopInput.parse({
      name: 'London Fix',
      country: 'GB',
      phone: '020 7946 0018',
      postcode: 'sw1a1aa',
      timezone: 'europe/london',
      region: '',
      city: '',
    });
    expect(out).toEqual({
      name: 'London Fix',
      country: 'GB',
      phone: '+442079460018',
      postcode: 'SW1A 1AA',
      timezone: 'Europe/London',
    });
  });
  it('keeps the Sprint 0 minimal shape valid', () => {
    expect(CreateShopInput.parse({ name: 'Fix It', country: 'US' })).toEqual({ name: 'Fix It', country: 'US' });
  });
  it('reports country-dependent errors on the field path', () => {
    const r = CreateShopInput.safeParse({ name: 'Fix It', country: 'US', phone: '12', postcode: 'SW1A 1AA', timezone: 'Europe/London', region: 'Ontario' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.path)).toEqual([['phone'], ['postcode'], ['region'], ['timezone']]);
    }
  });
});

describe('shop profile update', () => {
  it('rejects country and currency (read-only)', () => {
    expect(UpdateShopProfileInput.safeParse({ country: 'GB' }).success).toBe(false);
    expect(UpdateShopProfileInput.safeParse({ currency: 'GBP' }).success).toBe(false);
  });
  it('normalises for the shop country; undefined = unchanged, null/"" = clear', () => {
    const out = shopProfileSchema('PK').parse({ phone: '0300 1234567', postcode: '', region: 'punjab', city: null });
    expect(out).toEqual({ phone: '+923001234567', postcode: null, region: 'Punjab', city: null });
    expect('name' in out).toBe(false);
  });
  it('validates against the shop country', () => {
    expect(shopProfileSchema('US').safeParse({ postcode: '54000-12' }).success).toBe(false);
    expect(shopProfileSchema('US').safeParse({ timezone: 'Asia/Karachi' }).success).toBe(false);
    expect(shopProfileSchema('US').parse({ timezone: 'america/chicago' }).timezone).toBe('America/Chicago');
  });
});
