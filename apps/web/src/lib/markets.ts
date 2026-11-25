import type { CountryCode } from '@repairos/contracts';

export const COUNTRY_OPTIONS: { value: CountryCode; label: string }[] = [
  { value: 'US', label: 'United States' },
  { value: 'GB', label: 'United Kingdom' },
  { value: 'PK', label: 'Pakistan' },
];

export function countryLabel(code: CountryCode): string {
  return COUNTRY_OPTIONS.find((o) => o.value === code)?.label ?? code;
}
