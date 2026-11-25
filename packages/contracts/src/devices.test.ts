import { describe, expect, it } from 'vitest';
import {
  CHECKLIST_ITEMS_BY_DEVICE_TYPE,
  CreateDeviceInput,
  DEVICE_BRANDS_BY_TYPE,
  DEVICE_MODEL_CATALOGUE,
  DEVICE_TYPES,
  DeviceLookupQuery,
  IMEI_ERROR,
  IMEI_LENGTH_HINT,
  ISSUE_PRESETS_BY_DEVICE_TYPE,
  Imei,
  PasscodeInput,
  PasscodeReveal,
  PatternLock,
  UpdateDeviceInput,
  ModelSuggestionsQuery,
  catalogueModels,
  suggestModels,
  deviceLabel,
  formatPattern,
  isValidImei,
  luhnValid,
  maskIdentifier,
  normalizeImei,
  normalizeSerial,
  parsePattern,
} from './index';

describe('IMEI (DV2)', () => {
  it('Luhn', () => {
    expect(luhnValid('490154203237518')).toBe(true);
    expect(luhnValid('490154203237519')).toBe(false);
    expect(luhnValid('79927398713')).toBe(true);
    expect(luhnValid('abc')).toBe(false);
  });
  it('normalises spaces, dashes and slashes, then needs 15 digits + Luhn', () => {
    expect(normalizeImei(' 49-015420/323751 8 ')).toBe('490154203237518');
    expect(isValidImei('49-015420-323751-8')).toBe(true);
    expect(isValidImei('35 693803 564380 9')).toBe(true);
    expect(isValidImei('490154203237519')).toBe(false);
    expect(isValidImei('49015420323751')).toBe(false); // 14
    expect(isValidImei('4901542032375180')).toBe(false); // 16 (IMEISV)
  });
  it('schema keeps leading zeros and gives the story messages', () => {
    expect(Imei.parse('490154203237518')).toBe('490154203237518');
    const zero = '000000000000000';
    expect(luhnValid(zero)).toBe(true);
    expect(Imei.parse(zero)).toBe(zero);
    const short = Imei.safeParse('49015420323751');
    expect(!short.success && short.error.issues[0]?.message).toBe(`${IMEI_ERROR} ${IMEI_LENGTH_HINT}`);
    const imeisv = Imei.safeParse('4901542032375180');
    expect(!imeisv.success && imeisv.error.issues[0]?.message).toContain(IMEI_LENGTH_HINT);
    const bad = Imei.safeParse('490154203237519');
    expect(!bad.success && bad.error.issues[0]?.message).toBe(IMEI_ERROR);
    const letters = Imei.safeParse('49015420323751X');
    expect(!letters.success && letters.error.issues[0]?.message).toBe(IMEI_ERROR);
  });
});

describe('serial (DV2.3)', () => {
  it('trims, removes spaces/dashes, upper-cases; 4–30 [A-Z0-9]', () => {
    expect(normalizeSerial(' c02x-1234 abcd ')).toBe('C02X1234ABCD');
    expect(normalizeSerial('abc')).toBeNull();
    expect(normalizeSerial('A'.repeat(30))).toBe('A'.repeat(30));
    expect(normalizeSerial('A'.repeat(31))).toBeNull();
    expect(normalizeSerial('AB#12')).toBeNull();
    expect(normalizeSerial('')).toBeNull();
    expect(normalizeSerial(null)).toBeNull();
  });
});

describe('passcode (DV3)', () => {
  it('pattern: 4–9 distinct dots 1–9, stored as "1-5-9-6"', () => {
    expect(PatternLock.safeParse([1, 5, 9, 6]).success).toBe(true);
    expect(PatternLock.safeParse([1, 5, 9]).success).toBe(false);
    expect(PatternLock.safeParse([1, 5, 5, 6]).success).toBe(false);
    expect(PatternLock.safeParse([0, 1, 2, 3]).success).toBe(false);
    expect(PatternLock.safeParse([1, 2, 3, 4, 5, 6, 7, 8, 9]).success).toBe(true);
    expect(formatPattern([1, 5, 9, 6])).toBe('1-5-9-6');
    expect(parsePattern('1-5-9-6')).toEqual([1, 5, 9, 6]);
    expect(parsePattern('1-1-2-3')).toBeNull();
    expect(parsePattern('1-5')).toBeNull();
    expect(parsePattern('a-b-c-d')).toBeNull();
  });
  it('PIN is 4–16 digits kept as a string; password printable 1–64', () => {
    expect(PasscodeInput.parse({ lockType: 'PIN', value: '0042' })).toEqual({ lockType: 'PIN', value: '0042' });
    expect(PasscodeInput.safeParse({ lockType: 'PIN', value: '123' }).success).toBe(false);
    expect(PasscodeInput.safeParse({ lockType: 'PIN', value: '12a4' }).success).toBe(false);
    expect(PasscodeInput.safeParse({ lockType: 'PIN', value: '1'.repeat(17) }).success).toBe(false);
    expect(PasscodeInput.safeParse({ lockType: 'PASSWORD', value: ' p@ss wörd ' }).success).toBe(true);
    expect(PasscodeInput.safeParse({ lockType: 'PASSWORD', value: 'a\u0007b' }).success).toBe(false);
    expect(PasscodeInput.safeParse({ lockType: 'PASSWORD', value: 'x'.repeat(65) }).success).toBe(false);
    expect(PasscodeInput.safeParse({ lockType: 'PATTERN', pattern: [3, 2, 1, 4] }).success).toBe(true);
    expect(PasscodeInput.safeParse({ lockType: 'NONE', value: '1234' }).success).toBe(false);
    expect(PasscodeInput.safeParse({ lockType: 'NOT_SHARED' }).success).toBe(true);
  });
  it('reveal response carries the value only for secret lock types', () => {
    const at = '2026-11-25T10:00:00.000Z';
    expect(PasscodeReveal.safeParse({ lockType: 'PIN', value: '0042', viewCount: 1, revealedAt: at }).success).toBe(true);
    expect(PasscodeReveal.safeParse({ lockType: 'NONE', viewCount: 1, revealedAt: at }).success).toBe(false);
  });
});

describe('device input', () => {
  const ok = { type: 'PHONE', brand: 'Apple', model: 'iPhone 13' } as const;
  it('creates with defaults and normalises IMEI/serial', () => {
    const d = CreateDeviceInput.parse({ ...ok, imei: '49 015420 323751 8', serial: 'f17-abc 123', colour: ' ' });
    expect(d).toMatchObject({ imei: '490154203237518', serial: 'F17ABC123', colour: null, notes: null });
    expect(CreateDeviceInput.parse({ ...ok, imei: '' }).imei).toBeNull();
  });
  it('IMEI only for phone, tablet and watch', () => {
    expect(CreateDeviceInput.safeParse({ ...ok, type: 'LAPTOP', imei: '490154203237518' }).success).toBe(false);
    expect(CreateDeviceInput.safeParse({ ...ok, type: 'WATCH', imei: '490154203237518' }).success).toBe(true);
  });
  it('requires brand and model', () => {
    expect(CreateDeviceInput.safeParse({ ...ok, model: ' ' }).success).toBe(false);
    expect(CreateDeviceInput.safeParse({ ...ok, brand: '' }).success).toBe(false);
  });
  it('PATCH keeps absent fields undefined and null clears', () => {
    const p = UpdateDeviceInput.parse({ model: 'iPhone 14' });
    expect(p.imei).toBeUndefined();
    expect(p.colour).toBeUndefined();
    expect(UpdateDeviceInput.parse({ imei: null, colour: null })).toMatchObject({ imei: null, colour: null });
  });
  it('lookup needs exactly one of IMEI or serial', () => {
    expect(DeviceLookupQuery.safeParse({ imei: '490154203237518' }).success).toBe(true);
    expect(DeviceLookupQuery.safeParse({}).success).toBe(false);
    expect(DeviceLookupQuery.safeParse({ imei: '490154203237518', serial: 'ABCD1' }).success).toBe(false);
  });
});

describe('built-in data', () => {
  it('every type has brands (except Other), issues and checklist items', () => {
    for (const t of DEVICE_TYPES) {
      if (t !== 'OTHER') expect(DEVICE_BRANDS_BY_TYPE[t].length, t).toBeGreaterThan(0);
      expect(ISSUE_PRESETS_BY_DEVICE_TYPE[t].length, t).toBeGreaterThan(0);
      expect(CHECKLIST_ITEMS_BY_DEVICE_TYPE[t].length, t).toBeGreaterThan(0);
      const keys = CHECKLIST_ITEMS_BY_DEVICE_TYPE[t].map((i) => i.key);
      expect(new Set(keys).size, t).toBe(keys.length);
    }
  });
  it('catalogue has ~150+ unique entries whose brands are offered for their type', () => {
    expect(DEVICE_MODEL_CATALOGUE.length).toBeGreaterThanOrEqual(150);
    const keys = DEVICE_MODEL_CATALOGUE.map((m) => `${m.type}|${m.brand}|${m.model}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const m of DEVICE_MODEL_CATALOGUE) expect(DEVICE_BRANDS_BY_TYPE[m.type], m.model).toContain(m.brand);
  });
  it('model suggestions filter by brand and every word', () => {
    expect(catalogueModels('PHONE', 'apple', '13 pro')).toEqual(['iPhone 13 Pro', 'iPhone 13 Pro Max']);
    expect(catalogueModels('CONSOLE', 'Nintendo', 'oled')).toEqual(['Switch OLED']);
    expect(catalogueModels('PHONE', 'Infinix').length).toBeGreaterThan(0);
  });
  it('R1/R2: one-box model search without type/brand, exact and shortest first', () => {
    const hits = suggestModels({ q: 'iph 13' });
    expect(hits[0]).toEqual({ type: 'PHONE', brand: 'Apple', model: 'iPhone 13', source: 'catalogue', useCount: 0 });
    expect(hits.map((h) => h.model)).toEqual(['iPhone 13', 'iPhone 13 Pro', 'iPhone 13 mini', 'iPhone 13 Pro Max']);
    expect(suggestModels({ q: 'iphone 13 mini' })[0]!.model).toBe('iPhone 13 mini');
    expect(suggestModels({ q: 'apple iphone 13' })[0]!.model).toBe('iPhone 13'); // exact on "brand model"
    expect(suggestModels({ q: 'galaxy a5' }).map((h) => h.model)).toEqual(['Galaxy A53', 'Galaxy A54', 'Galaxy A55']);
    expect(suggestModels({ q: 'oled', type: 'CONSOLE' }).map((h) => h.model)).toEqual(['Switch OLED', 'Steam Deck OLED']);
    expect(suggestModels({ q: '13', brand: 'google' })).toEqual([]);
    expect(suggestModels({ q: 'ipad', limit: 3 })).toHaveLength(3);
    // ModelSuggestionsQuery: type optional
    expect(ModelSuggestionsQuery.parse({ q: 'iph 13' })).toEqual({ q: 'iph 13', limit: 20 });
  });
  it('R1: shop history merges with the catalogue (case-insensitive) and ranks by use count on ties', () => {
    const shopHistory = [
      { type: 'PHONE' as const, brand: 'apple', model: 'iphone 13', useCount: 4 },
      { type: 'PHONE' as const, brand: 'Nokia', model: 'Nokia 3310', useCount: 2 },
    ];
    const hits = suggestModels({ q: 'iphone 13', type: 'PHONE', shopHistory });
    expect(hits[0]).toMatchObject({ brand: 'Apple', model: 'iPhone 13', source: 'shop', useCount: 4 });
    const none = suggestModels({ type: 'PHONE', shopHistory, limit: 2 });
    expect(none.map((h) => h.model)).toEqual(['iPhone 13', 'Nokia 3310']);
    expect(suggestModels({ q: '3310', shopHistory })[0]).toMatchObject({ brand: 'Nokia', source: 'shop' });
  });
  it('labels', () => {
    expect(deviceLabel({ brand: 'Apple', model: 'iPhone 13' })).toBe('Apple iPhone 13');
    expect(deviceLabel({ brand: 'Redmi', model: 'Redmi Note 12' })).toBe('Redmi Note 12');
    expect(maskIdentifier('490154203237518')).toBe('•••• 7518');
  });
});
