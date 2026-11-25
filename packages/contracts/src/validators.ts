import { getCountryCallingCode, parsePhoneNumberFromString } from 'libphonenumber-js';
import { z } from 'zod';
import type { CountryCode } from './markets';

/**
 * Per-country validators shared by onboarding (`CreateShopInput`) and shop settings (`shopProfileSchema`).
 * Every `normalize*` helper returns the canonical stored value, or null when the input is invalid.
 */

// ---------- Phone ----------

/**
 * Parses with the shop's country as default region (numbers in +E.164 from any country are also accepted)
 * and returns E.164, e.g. PK "0300 1234567" → "+923001234567". Null when invalid or empty.
 */
export function normalizePhone(raw: string | null | undefined, country: CountryCode): string | null {
  if (!raw || raw.trim() === '') return null;
  const parsed = parsePhoneNumberFromString(raw.trim(), country);
  return parsed && parsed.isValid() ? parsed.number : null;
}

/**
 * Display an E.164 number in national format when it shares the shop country's calling code (international format
 * otherwise). Compared by calling code, not region: libphonenumber classifies some UK ranges (+44 7911…) as Crown
 * Dependencies (GG/JE/IM), which are still dialled nationally from the UK (R7).
 */
export function formatPhone(e164: string, country: CountryCode): string {
  const parsed = parsePhoneNumberFromString(e164);
  if (!parsed) return e164;
  return parsed.countryCallingCode === getCountryCallingCode(country) ? parsed.formatNational() : parsed.formatInternational();
}

// ---------- Postcode ----------

const US_ZIP = /^\d{5}(-\d{4})?$/;
/** Outward code + inward code (space removed before matching); includes the GIR 0AA special case. */
const GB_POSTCODE = /^(GIR0AA|[A-PR-UWYZ][A-HK-Y]?\d[A-Z\d]?\d[ABD-HJLNP-UW-Z]{2})$/;
const PK_POSTAL = /^\d{5}$/;

export const POSTCODE_LABELS: Record<CountryCode, string> = { US: 'ZIP code', GB: 'Postcode', PK: 'Postal code' };

/**
 * US: "12345" or "12345-6789". GB: upper-cased, one space before the last 3 chars ("sw1a1aa" → "SW1A 1AA").
 * PK: 5 digits. Null when invalid or empty.
 */
export function normalizePostcode(raw: string | null | undefined, country: CountryCode): string | null {
  if (!raw || raw.trim() === '') return null;
  const value = raw.trim();
  switch (country) {
    case 'US':
      return US_ZIP.test(value) ? value : null;
    case 'PK':
      return PK_POSTAL.test(value) ? value : null;
    case 'GB': {
      const compact = value.replace(/\s+/g, '').toUpperCase();
      return GB_POSTCODE.test(compact) ? `${compact.slice(0, -3)} ${compact.slice(-3)}` : null;
    }
  }
}

// ---------- Time zone ----------

export interface TimezoneOption {
  /** IANA name, the stored value */
  value: string;
  /** e.g. "Eastern Time (New York)" */
  label: string;
}

/** The only time zones a shop may use, per country. The first entry is the market default. */
export const TIMEZONES_BY_COUNTRY: Record<CountryCode, readonly TimezoneOption[]> = {
  US: [
    { value: 'America/New_York', label: 'Eastern Time (New York)' },
    { value: 'America/Chicago', label: 'Central Time (Chicago)' },
    { value: 'America/Denver', label: 'Mountain Time (Denver)' },
    { value: 'America/Phoenix', label: 'Mountain Time – Arizona (Phoenix)' },
    { value: 'America/Los_Angeles', label: 'Pacific Time (Los Angeles)' },
    { value: 'America/Anchorage', label: 'Alaska Time (Anchorage)' },
    { value: 'Pacific/Honolulu', label: 'Hawaii Time (Honolulu)' },
  ],
  GB: [{ value: 'Europe/London', label: 'UK Time (London)' }],
  PK: [{ value: 'Asia/Karachi', label: 'Pakistan Time (Karachi)' }],
};

/** Canonical allow-listed IANA name (case-insensitive match, "europe/london" → "Europe/London"), or null. */
export function normalizeTimezone(raw: string | null | undefined, country: CountryCode): string | null {
  if (!raw) return null;
  const wanted = raw.trim().toLowerCase();
  return TIMEZONES_BY_COUNTRY[country].find((tz) => tz.value.toLowerCase() === wanted)?.value ?? null;
}

export function timezoneLabel(value: string): string {
  for (const list of Object.values(TIMEZONES_BY_COUNTRY)) {
    const hit = list.find((tz) => tz.value === value);
    if (hit) return hit.label;
  }
  return value;
}

// ---------- Region ----------

export const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS',
  'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC',
  'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
] as const;

export const PK_PROVINCES = [
  'Punjab',
  'Sindh',
  'Khyber Pakhtunkhwa',
  'Balochistan',
  'Islamabad Capital Territory',
  'Gilgit-Baltistan',
  'Azad Jammu & Kashmir',
] as const;

export const REGION_LABELS: Record<CountryCode, string> = { US: 'State', GB: 'County', PK: 'Province' };
export const CITY_LABELS: Record<CountryCode, string> = { US: 'City', GB: 'Town/City', PK: 'City' };

/**
 * US: 2-letter state code (50 states + DC; stored upper-case). GB: free text ≤ 80. PK: one of `PK_PROVINCES`
 * (case-insensitive, stored canonical). Null when invalid or empty.
 */
export function normalizeRegion(raw: string | null | undefined, country: CountryCode): string | null {
  if (!raw || raw.trim() === '') return null;
  const value = raw.trim();
  switch (country) {
    case 'US': {
      const code = value.toUpperCase();
      return (US_STATES as readonly string[]).includes(code) ? code : null;
    }
    case 'PK':
      return PK_PROVINCES.find((p) => p.toLowerCase() === value.toLowerCase()) ?? null;
    case 'GB':
      return value.length <= 80 ? value : null;
  }
}

// ---------- Zod helpers ----------

/** Optional free-text field: trims; "" and null become null on output. */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

export interface CountryFields {
  phone?: string | null;
  postcode?: string | null;
  region?: string | null;
  timezone?: string | null;
}

/**
 * Validates and normalises the country-dependent fields in place (Zod `superRefine` + `transform` pair).
 * Issues use the field name as path, so API errors map back onto form fields.
 */
export function checkCountryFields(value: CountryFields, country: CountryCode, ctx: z.RefinementCtx): void {
  if (value.phone && normalizePhone(value.phone, country) === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['phone'], message: 'Enter a valid phone number' });
  }
  if (value.postcode && normalizePostcode(value.postcode, country) === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['postcode'],
      message: `Enter a valid ${POSTCODE_LABELS[country].toLowerCase()}`,
    });
  }
  if (value.region && normalizeRegion(value.region, country) === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['region'],
      message: `Choose a valid ${REGION_LABELS[country].toLowerCase()}`,
    });
  }
  if (value.timezone && normalizeTimezone(value.timezone, country) === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['timezone'], message: 'Choose a time zone from the list' });
  }
}
